require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { connectKafkaProducer, publishAdminActionEvent } = require('./kafkaClient');
const { protect, authorize } = require('./middleware/authMiddleware');
const AdminUser = require('./models/AdminUser');
const DriverDocument = require('./models/DriverDocument'); // For document management
const { logError } = require('../utils/logger');
const { getFetch } = require('./fetchHelper'); // Use fetch helper

const app = express();

// Middleware
app.use(cors()); // Enable CORS for all origins (adjust for production)
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const MONGODB_URI = process.env.ADMIN_SERVICE_MONGODB_URI || 'mongodb://localhost:27017/admin_service';
const JWT_SECRET = process.env.JWT_SECRET || 'YourSuperSecretKeyForJWT';
const RIDE_SERVICE_URL = process.env.RIDE_SERVICE_URL || 'http://localhost:3000';
const DRIVER_SERVICE_URL = process.env.DRIVER_SERVICE_URL || 'http://localhost:3001';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3006';
const PAYMENT_SERVICE_URL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3004';
const SUPPORT_SERVICE_URL = process.env.SUPPORT_SERVICE_URL || 'http://localhost:3007';
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL || 'http://localhost:3008';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3002';

let isKafkaProducerConnected = false;
const SERVICE_NAME = 'admin-service';

// --- Database Connection ---
mongoose.connect(MONGODB_URI)
  .then(async () => {
      console.log('AdminService MongoDB connected');
      // Ensure default admin user exists on startup
      await ensureDefaultAdmin();
  })
  .catch(err => {
    console.error('AdminService MongoDB connection error:', err);
    logError(SERVICE_NAME, err, 'MongoDB Connection');
    process.exit(1);
  });

// --- Kafka Connection ---
connectKafkaProducer().then(connected => {
    isKafkaProducerConnected = connected;
    if (connected) console.log('AdminService Kafka Producer connected');
    else console.warn('AdminService Kafka Producer connection failed. Events will not be published.');
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Producer Connection'));


// --- Helper Functions ---
async function ensureDefaultAdmin() {
    const defaultUsername = process.env.ADMIN_DEFAULT_USER || 'admin';
    const defaultPassword = process.env.ADMIN_DEFAULT_PASSWORD || 'password';

    try {
        const existingAdmin = await AdminUser.findOne({ username: defaultUsername });
        if (!existingAdmin) {
            const admin = new AdminUser({
                username: defaultUsername,
                password: defaultPassword, // Hashing is done by pre-save hook
                role: 'superadmin', // Default admin is superadmin
                name: 'Default Admin',
                isActive: true
            });
            await admin.save();
            console.log(`Default admin user '${defaultUsername}' created.`);
        } else {
            // console.log(`Default admin user '${defaultUsername}' already exists.`);
        }
    } catch (error) {
        logError(SERVICE_NAME, error, 'Ensure Default Admin User');
        console.error("Error ensuring default admin user:", error);
    }
}

async function makeServiceRequest(url, method = 'GET', body = null, token = null) {
    try {
        const fetch = await getFetch();
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`; // Forward token if needed
        }
        const options = { method, headers };
        if (body) {
            options.body = JSON.stringify(body);
        }
        const response = await fetch(url, options);
        const data = await response.json(); // Attempt to parse JSON regardless of status
        if (!response.ok) {
            const error = new Error(data.message || `Request to ${url} failed with status ${response.status}`);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    } catch (error) {
        logError(SERVICE_NAME, error, `Service Request to ${url}`);
        // Rethrow the error so the caller can handle it
        throw error;
    }
}


// --- Admin Authentication Routes ---
app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required' });
    }

    try {
        const admin = await AdminUser.findOne({ username: username.toLowerCase() }).select('+password');
        if (!admin) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const isMatch = await admin.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (!admin.isActive) {
             return res.status(403).json({ message: 'Account is inactive' });
         }

        // Generate JWT
        const payload = { userId: admin._id, role: admin.role, username: admin.username };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' }); // 8 hour expiry for admins

        // Update last login time (fire and forget)
        AdminUser.findByIdAndUpdate(admin._id, { lastLogin: new Date() }).catch(err => logError(SERVICE_NAME, err, 'Update Last Login'));

        res.status(200).json({
            token,
            user: { id: admin._id, username: admin.username, name: admin.name, role: admin.role }
        });

    } catch (error) {
        logError(SERVICE_NAME, error, 'Admin Login');
        res.status(500).json({ message: 'Server error during admin login' });
    }
});

// --- Protected Routes ---

// Example: Get current admin user profile
app.get('/auth/me', protect, (req, res) => {
    // req.adminUser is populated by the 'protect' middleware
     res.status(200).json(req.adminUser);
});

// --- Driver Management ---

// Get list of drivers (proxies to Driver Service or User Service)
app.get('/drivers', protect, authorize('admin', 'superadmin', 'operations'), async (req, res) => {
    try {
        // Example: Fetching from User Service as it might have more profile info
        // Add query params for filtering/pagination as needed
        const drivers = await makeServiceRequest(`${USER_SERVICE_URL}/users?role=driver`); // Assume endpoint exists
        res.status(200).json(drivers);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Failed to fetch drivers' });
    }
});

// Get driver details (proxies to User Service)
app.get('/drivers/:driverId', protect, authorize('admin', 'superadmin', 'operations'), async (req, res) => {
    try {
        const driver = await makeServiceRequest(`${USER_SERVICE_URL}/users/${req.params.driverId}`);
        if (driver.role !== 'driver') {
            return res.status(404).json({ message: 'User is not a driver' });
        }
        res.status(200).json(driver);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Failed to fetch driver details' });
    }
});


// --- Document Management (assuming documents are uploaded elsewhere and URL is stored) ---

// Endpoint to receive uploaded document info (could be called by Driver Service or directly)
app.post('/drivers/:driverId/documents', protect, authorize('admin', 'superadmin'), async (req, res) => {
    const { driverId } = req.params;
    const { documentType, documentUrl, expiryDate } = req.body;

    if (!documentType || !documentUrl) {
        return res.status(400).json({ message: 'documentType and documentUrl are required' });
    }

    try {
        const newDoc = new DriverDocument({
            driverId,
            documentType,
            documentUrl,
            expiryDate,
            status: 'pending_review'
        });
        await newDoc.save();
        console.log(`Document ${documentType} added for driver ${driverId}`);
        res.status(201).json(newDoc);
    } catch (error) {
        logError(SERVICE_NAME, error, `Add Driver Document ${driverId}`);
        res.status(500).json({ message: 'Failed to add driver document' });
    }
});

// Get pending documents for review
app.get('/documents/pending', protect, authorize('admin', 'superadmin'), async (req, res) => {
    try {
        const pendingDocs = await DriverDocument.find({ status: 'pending_review' }).sort({ uploadedAt: 1 });
        res.status(200).json(pendingDocs);
    } catch (error) {
        logError(SERVICE_NAME, error, 'Get Pending Documents');
        res.status(500).json({ message: 'Failed to fetch pending documents' });
    }
});

// Approve or Reject a document
app.put('/documents/:documentId/status', protect, authorize('admin', 'superadmin'), async (req, res) => {
    const { documentId } = req.params;
    const { status, rejectionReason } = req.body; // Expect status: 'approved' or 'rejected'

    if (!status || !['approved', 'rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status provided. Must be "approved" or "rejected".' });
    }
    if (status === 'rejected' && !rejectionReason) {
        return res.status(400).json({ message: 'Rejection reason is required when rejecting a document.' });
    }

    try {
        const updateData = {
            status,
            reviewedBy: req.adminUser._id, // Log which admin reviewed it
            reviewedAt: new Date(),
            rejectionReason: status === 'rejected' ? rejectionReason : null
        };

        const updatedDoc = await DriverDocument.findByIdAndUpdate(documentId, updateData, { new: true });

        if (!updatedDoc) {
            return res.status(404).json({ message: 'Document not found' });
        }

        console.log(`Document ${documentId} status updated to ${status} by admin ${req.adminUser.username}`);

        // Check if all required documents for this driver are now approved
        const driverId = updatedDoc.driverId;
        const requiredDocTypes = ['license', 'insurance', 'vehicle_registration', 'profile_photo']; // Example required types
        const driverDocs = await DriverDocument.find({ driverId: driverId });

        const allApproved = requiredDocTypes.every(type =>
            driverDocs.some(doc => doc.documentType === type && doc.status === 'approved')
        );

        if (allApproved) {
             console.log(`All required documents approved for driver ${driverId}. Publishing driver_approved event.`);
             // Publish event to notify Driver Service and User Service
             publishAdminActionEvent('driver_approved', { driverId: driverId, reviewedBy: req.adminUser._id })
                 .catch(err => logError(SERVICE_NAME, err, 'Kafka Publish driver_approved'));

             // Potentially call User Service directly as fallback
             try {
                 await makeServiceRequest(`${USER_SERVICE_URL}/users/${driverId}/status`, 'PUT', { accountStatus: 'active' });
             } catch (userServiceError) {
                 logError(SERVICE_NAME, userServiceError, `Failed fallback call to User Service for driver approval ${driverId}`);
             }

         } else if (status === 'rejected') {
              // Publish rejected event - driver might need to re-upload
              publishAdminActionEvent('driver_doc_rejected', { driverId: driverId, documentId: documentId, reason: rejectionReason, reviewedBy: req.adminUser._id })
                 .catch(err => logError(SERVICE_NAME, err, 'Kafka Publish driver_doc_rejected'));
              // TODO: Notify driver via Notification Service
         }

        res.status(200).json(updatedDoc);

    } catch (error) {
        logError(SERVICE_NAME, error, `Update Document Status ${documentId}`);
        res.status(500).json({ message: 'Failed to update document status' });
    }
});


// --- Ride & User Monitoring (Proxy Endpoints) ---

// Get recent rides
app.get('/rides', protect, authorize('admin', 'superadmin', 'operations', 'support_lead'), async (req, res) => {
    try {
        // Proxy to Ride Service, adding any admin-specific filters if needed
        const rides = await makeServiceRequest(`${RIDE_SERVICE_URL}/rides`); // Assume Ride Service has a general list endpoint
        res.status(200).json(rides);
    } catch (error) {
         res.status(error.status || 500).json({ message: error.message || 'Failed to fetch rides' });
    }
});

// Get ride details
app.get('/rides/:rideId', protect, authorize('admin', 'superadmin', 'operations', 'support_lead'), async (req, res) => {
     try {
         const ride = await makeServiceRequest(`${RIDE_SERVICE_URL}/rides/${req.params.rideId}`);
         res.status(200).json(ride);
     } catch (error) {
         res.status(error.status || 500).json({ message: error.message || 'Failed to fetch ride details' });
     }
 });

// Get list of users (riders/drivers)
app.get('/users', protect, authorize('admin', 'superadmin', 'operations'), async (req, res) => {
    try {
        const users = await makeServiceRequest(`${USER_SERVICE_URL}/users`); // Assume User Service has a list endpoint
        res.status(200).json(users);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Failed to fetch users' });
    }
});

// Suspend/Ban/Activate User Account
app.put('/users/:userId/status', protect, authorize('admin', 'superadmin'), async (req, res) => {
    const { userId } = req.params;
    const { accountStatus, reason } = req.body; // Expect 'active', 'suspended', 'banned'

     if (!accountStatus || !['active', 'suspended', 'banned'].includes(accountStatus)) {
         return res.status(400).json({ message: 'Invalid accountStatus provided.' });
     }

    try {
         // Update status in User Service
         const updatedUser = await makeServiceRequest(`${USER_SERVICE_URL}/users/${userId}/status`, 'PUT', { accountStatus });

         console.log(`Admin ${req.adminUser.username} updated user ${userId} status to ${accountStatus}`);

         // Publish event for Auth Service / Notification Service
         publishAdminActionEvent('admin_user_status_updated', { userId, accountStatus, reason, adminUserId: req.adminUser._id })
            .catch(err => logError(SERVICE_NAME, err, 'Kafka Publish admin_user_status_updated'));

         res.status(200).json({ message: `User status updated to ${accountStatus}`, user: updatedUser });

    } catch (error) {
         res.status(error.status || 500).json({ message: error.message || 'Failed to update user status' });
    }
});


// --- Analytics Data Proxy ---
app.get('/analytics/summary/today', protect, authorize('admin', 'superadmin', 'operations'), async (req, res) => {
    try {
        const summary = await makeServiceRequest(`${ANALYTICS_SERVICE_URL}/analytics/summary/today`);
        res.status(200).json(summary);
    } catch (error) {
         res.status(error.status || 500).json({ message: error.message || 'Failed to fetch today\'s analytics summary' });
    }
});

app.get('/analytics/summary/:date', protect, authorize('admin', 'superadmin', 'operations'), async (req, res) => {
    try {
        const summary = await makeServiceRequest(`${ANALYTICS_SERVICE_URL}/analytics/summary/${req.params.date}`);
        res.status(200).json(summary);
    } catch (error) {
         res.status(error.status || 500).json({ message: error.message || `Failed to fetch analytics summary for ${req.params.date}` });
    }
});


// --- Support Ticket Proxy ---
app.get('/support/tickets', protect, authorize('admin', 'superadmin', 'support_lead'), async (req, res) => {
    try {
        // Add query params for filtering status=open etc.
        const tickets = await makeServiceRequest(`${SUPPORT_SERVICE_URL}/tickets`); // Assuming list endpoint exists
        res.status(200).json(tickets);
    } catch (error) {
         res.status(error.status || 500).json({ message: error.message || 'Failed to fetch support tickets' });
    }
});

app.get('/support/tickets/:ticketId', protect, authorize('admin', 'superadmin', 'support_lead'), async (req, res) => {
     try {
         const ticket = await makeServiceRequest(`${SUPPORT_SERVICE_URL}/tickets/${req.params.ticketId}`);
         res.status(200).json(ticket);
     } catch (error) {
         res.status(error.status || 500).json({ message: error.message || 'Failed to fetch support ticket details' });
     }
 });

app.put('/support/tickets/:ticketId', protect, authorize('admin', 'superadmin', 'support_lead'), async (req, res) => {
    try {
        const updatedTicket = await makeServiceRequest(`${SUPPORT_SERVICE_URL}/tickets/${req.params.ticketId}`, 'PUT', req.body);
        res.status(200).json(updatedTicket);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Failed to update support ticket' });
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
const PORT = process.env.ADMIN_SERVICE_PORT || 3009;
app.listen(PORT, () => {
    console.log(`Admin Service listening on port ${PORT}`);
});

// Basic Error Handling Middleware
app.use((err, req, res, next) => {
  logError(SERVICE_NAME, err, 'Unhandled Route Error');
  res.status(500).send('Something broke!');
});
