require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { connectKafkaProducer, publishSupportEvent } = require('./kafkaClient');
const SupportTicket = require('./models/SupportTicket');
const { logError } = require('../utils/logger'); // Import logger
const { getFetch } = require('./fetchHelper'); // Use fetch helper

const app = express();
app.use(express.json());

const MONGODB_URI = process.env.SUPPORT_SERVICE_MONGODB_URI || 'mongodb://localhost:27017/support_service';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3002';

let isKafkaProducerConnected = false;
const SERVICE_NAME = 'support-service';

// --- Database Connection ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log('SupportService MongoDB connected'))
  .catch(err => {
    console.error('SupportService MongoDB connection error:', err);
    logError(SERVICE_NAME, err, 'MongoDB Connection');
    process.exit(1); // Exit if DB fails
  });

// --- Kafka Connection ---
connectKafkaProducer().then(connected => {
    isKafkaProducerConnected = connected;
    if (connected) console.log('SupportService Kafka Producer connected');
    else console.warn('SupportService Kafka Producer connection failed. Support events will not be published.');
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Producer Connection'));

// --- Helper Function to Determine Severity ---
function determineSeverity(issueType) {
    switch (issueType) {
        case 'emergency':
        case 'safety_concern':
            return 'critical';
        case 'payment_dispute':
        case 'driver_behavior':
        case 'rider_behavior':
            return 'high';
        case 'lost_item':
        case 'vehicle_issue':
        case 'account_issue':
            return 'medium';
        case 'app_bug':
        case 'rating_dispute':
        case 'other':
        default:
            return 'low';
    }
}

// --- API Endpoints ---

// Create a new support ticket (from Rider/Driver App)
app.post('/tickets', async (req, res) => {
    const { userId, userRole, rideId, issueType, description, attachments } = req.body;

    if (!userId || !userRole || !issueType || !description) {
        return res.status(400).json({ message: 'Missing required fields: userId, userRole, issueType, description' });
    }
    if (!['rider', 'driver'].includes(userRole)) {
         return res.status(400).json({ message: 'Invalid userRole specified.' });
     }

    try {
        const severity = determineSeverity(issueType);

        const newTicket = new SupportTicket({
            userId,
            userRole,
            rideId,
            issueType,
            description,
            attachments,
            severity,
            status: 'open'
        });

        const savedTicket = await newTicket.save();
        console.log(`Support ticket ${savedTicket._id} created for user ${userId}`);

        // Publish ticket_created event
        publishSupportEvent('ticket_created', savedTicket).catch(err => logError(SERVICE_NAME, err, 'Kafka Publish ticket_created'));

        // If critical/high severity, maybe trigger immediate alert via Notification Service
        if (severity === 'critical' || severity === 'high') {
            console.log(`High/Critical severity ticket ${savedTicket._id}. Triggering alert.`);
            // Simulate alerting support staff (e.g., via Notification Service or dedicated channel)
            try {
                const fetch = await getFetch();
                // Example: Notify a specific 'support-alerts' group/user ID
                await fetch(`${NOTIFICATION_SERVICE_URL}/notify/group/support-alerts`, { // Assuming such endpoint/group exists
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'support_alert',
                        message: `New ${severity} severity ticket created: ${savedTicket._id}. Issue: ${issueType}`,
                        ticket: savedTicket
                    }),
                });
            } catch (fetchError) {
                logError(SERVICE_NAME, fetchError, `Failed to send alert for ticket ${savedTicket._id}`);
            }
        }

        res.status(201).json(savedTicket);

    } catch (error) {
        logError(SERVICE_NAME, error, 'Create Ticket');
        res.status(500).json({ message: 'Failed to create support ticket' });
    }
});

// Get tickets for a specific user
app.get('/tickets/user/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const tickets = await SupportTicket.find({ userId: userId }).sort({ createdAt: -1 });
        res.status(200).json(tickets);
    } catch (error) {
        logError(SERVICE_NAME, error, `Get Tickets for User ${userId}`);
        res.status(500).json({ message: 'Failed to retrieve tickets' });
    }
});

// Get a specific ticket by ID
app.get('/tickets/:ticketId', async (req, res) => {
    const { ticketId } = req.params;
    try {
        const ticket = await SupportTicket.findById(ticketId);
        if (!ticket) {
            return res.status(404).json({ message: 'Ticket not found' });
        }
        res.status(200).json(ticket);
    } catch (error) {
        logError(SERVICE_NAME, error, `Get Ticket ${ticketId}`);
        res.status(500).json({ message: 'Failed to retrieve ticket' });
    }
});

// Update a ticket (e.g., by Admin/Support Staff)
// This endpoint might be better placed in Admin Service, but included here for completeness
app.put('/tickets/:ticketId', async (req, res) => {
    const { ticketId } = req.params;
    const { status, assignedTo, resolutionNotes } = req.body;
    const updateData = {};

    if (status) updateData.status = status;
    if (assignedTo) updateData.assignedTo = assignedTo;
    if (resolutionNotes) updateData.resolutionNotes = resolutionNotes;

    if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ message: 'No update fields provided' });
    }

    try {
        const updatedTicket = await SupportTicket.findByIdAndUpdate(
            ticketId,
            { $set: updateData },
            { new: true }
        );

        if (!updatedTicket) {
            return res.status(404).json({ message: 'Ticket not found' });
        }

        console.log(`Support ticket ${ticketId} updated. Status: ${updatedTicket.status}`);

        // Publish ticket_updated or ticket_resolved event
        const eventType = ['resolved', 'closed'].includes(updatedTicket.status) ? 'ticket_resolved' : 'ticket_updated';
        publishSupportEvent(eventType, updatedTicket).catch(err => logError(SERVICE_NAME, err, `Kafka Publish ${eventType}`));

        // Notify the user who created the ticket about the update/resolution
        try {
            const fetch = await getFetch();
             await fetch(`${NOTIFICATION_SERVICE_URL}/notify/user/${updatedTicket.userId}`, { // Assuming generic user endpoint
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({
                     type: 'support_ticket_update',
                     message: `Your support ticket #${ticketId.slice(-6)} has been updated. Status: ${updatedTicket.status}. ${updatedTicket.resolutionNotes ? `Resolution: ${updatedTicket.resolutionNotes}` : ''}`,
                     ticket: updatedTicket
                 }),
             });
        } catch (fetchError) {
             logError(SERVICE_NAME, fetchError, `Failed to send update notification for ticket ${ticketId}`);
        }

        res.status(200).json(updatedTicket);

    } catch (error) {
        logError(SERVICE_NAME, error, `Update Ticket ${ticketId}`);
        res.status(500).json({ message: 'Failed to update ticket' });
    }
});

// Emergency Button Endpoint (Simplified)
app.post('/emergency', async (req, res) => {
    const { userId, userRole, rideId, location } = req.body; // Expect current location

    if (!userId || !userRole || !rideId || !location) {
         return res.status(400).json({ message: 'Missing required emergency details' });
     }

    console.warn(`EMERGENCY TRIGGERED by ${userRole} ${userId} for ride ${rideId} at location:`, location);

     try {
         const emergencyTicket = new SupportTicket({
             userId,
             userRole,
             rideId,
             issueType: 'emergency',
             description: `Emergency button activated by ${userRole} during ride ${rideId}. Last known location: ${JSON.stringify(location)}`,
             severity: 'critical',
             status: 'escalated' // Immediately escalate
         });
         const savedTicket = await emergencyTicket.save();
         console.log(`Emergency ticket ${savedTicket._id} created.`);

         // Publish emergency event
         publishSupportEvent('emergency_triggered', savedTicket).catch(err => logError(SERVICE_NAME, err, 'Kafka Publish emergency_triggered'));

         // Trigger immediate alerts (e.g., to support staff, potentially emergency contacts)
         try {
             const fetch = await getFetch();
             // Alert support
             await fetch(`${NOTIFICATION_SERVICE_URL}/notify/group/support-emergency`, { // Dedicated emergency group
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({
                     type: 'emergency_alert',
                     message: `EMERGENCY ACTIVATED by ${userRole} ${userId} on ride ${rideId}. Ticket: ${savedTicket._id}`,
                     ticket: savedTicket,
                     location: location
                 }),
             });
              // TODO: Alert emergency contacts (requires fetching contacts from User Service)

         } catch (fetchError) {
              logError(SERVICE_NAME, fetchError, `Failed to send emergency alerts for ticket ${savedTicket._id}`);
         }

         // TODO: In a real system, integrate with external emergency services API if required.

         res.status(200).json({ message: 'Emergency signal received and escalated.', ticketId: savedTicket._id });

     } catch (error) {
         logError(SERVICE_NAME, error, 'Emergency Activation');
         res.status(500).json({ message: 'Failed to process emergency signal' });
     }
});


// --- Health Check ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        mongo: mongoose.connection.readyState === 1,
        kafkaProducer: isKafkaProducerConnected
    });
});

// --- Server Start ---
const PORT = process.env.SUPPORT_SERVICE_PORT || 3007;
app.listen(PORT, () => {
    console.log(`Support Service listening on port ${PORT}`);
});

// Basic Error Handling Middleware
app.use((err, req, res, next) => {
  logError(SERVICE_NAME, err, 'Unhandled Route Error');
  res.status(500).send('Something broke!');
});
