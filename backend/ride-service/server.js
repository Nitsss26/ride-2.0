require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { connectRedis, getRedisClient } = require('./redisClient');
const { connectKafkaProducer, getKafkaProducer, connectKafkaConsumer, setupRideServiceConsumer } = require('./kafkaClient');
const Ride = require('./models/Ride');
const { getFetch } = require('./fetchHelper');
const { logError } = require('../utils/logger'); // Import logger

const app = express();
app.use(express.json());

const MONGODB_URI = process.env.RIDE_SERVICE_MONGODB_URI || 'mongodb://localhost:27017/ride_service';
const DRIVER_SERVICE_URL = process.env.DRIVER_SERVICE_URL || 'http://localhost:3001';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3002';

const SERVICE_NAME = 'ride-service';
let isRedisConnected = false;
let isKafkaProducerConnected = false;
let isKafkaConsumerConnected = false;

// --- Database Connection ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log('RideService MongoDB connected'))
  .catch(err => {
      logError(SERVICE_NAME, err, 'MongoDB Connection');
      console.error('RideService MongoDB connection error:', err);
      process.exit(1); // Exit if DB fails
  });

// --- Redis Connection ---
connectRedis().then(connected => {
    isRedisConnected = connected;
    if (connected) console.log('RideService Redis connected');
    else console.warn('RideService Redis connection failed. Timers will not function.');
}).catch(err => logError(SERVICE_NAME, err, 'Redis Connection'));

// --- Kafka Connection ---
connectKafkaProducer().then(connected => {
    isKafkaProducerConnected = connected;
    if(connected) console.log('RideService Kafka Producer connected');
    else console.warn('RideService Kafka Producer connection failed. Events will not be published.');
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Producer Connection'));

connectKafkaConsumer('ride-service-group').then(connected => {
    isKafkaConsumerConnected = connected;
    if (connected) {
        console.log('RideService Kafka Consumer connected');
        setupRideServiceConsumer().catch(err => logError(SERVICE_NAME, err, "Kafka Consumer Setup"));
    } else {
        console.warn('RideService Kafka Consumer connection failed. Will not process events.');
    }
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Consumer Connection'));


// --- API Endpoints ---

// Request a new ride
app.post('/rides', async (req, res) => {
    const { riderId, pickupLocation, dropoffLocation, preferences } = req.body;

    if (!riderId || !pickupLocation || !dropoffLocation) {
        return res.status(400).json({ message: 'Missing required ride details' });
    }

    try {
        const newRide = new Ride({
            riderId,
            pickupLocation,
            dropoffLocation,
            preferences,
            status: 'requested',
        });

        const savedRide = await newRide.save();
        const rideId = savedRide._id.toString();
        console.log(`Ride ${rideId} created for rider ${riderId}`);

        // 1. Set 10-minute timer in Redis
        const redisClient = getRedisClient(); // Get client (might be null)
        if (redisClient) {
            try {
                const timerKey = `ride-timer:${rideId}`;
                await redisClient.set(timerKey, 'active', { EX: 600 }); // 10 minutes expiry
                 console.log(`Ride timer set in Redis for ride ${rideId}`);
            } catch (redisError) {
                logError(SERVICE_NAME, redisError, `Redis Set Timer Failed for ride ${rideId}`);
                console.warn(`Redis not connected or SET failed. Cannot set timer for ride ${rideId}.`);
            }
        } else {
             console.warn(`Redis not connected. Cannot set timer for ride ${rideId}.`);
        }


        // 2. Publish ride-requested event to Kafka
        const producer = getKafkaProducer(); // Get producer (might be null)
        if (producer) {
            try {
                await producer.send({
                    topic: 'ride-requests',
                    messages: [{ key: rideId, value: JSON.stringify(savedRide) }],
                });
                console.log(`Published ride-requested event for ride ${rideId}`);
            } catch (kafkaError) {
                logError(SERVICE_NAME, kafkaError, `Kafka Publish ride-requested Failed for ${rideId}`);
                console.error(`Kafka Producer error. Cannot publish ride-requested event for ${rideId}.`);
                // Continue without Kafka if needed, but log error
            }
        } else {
             console.warn(`Kafka Producer not connected. Cannot publish ride-requested event for ${rideId}. Simulating Driver Service call.`);
             // Simulate direct call if Kafka isn't available (for basic testing)
             try {
                 const fetch = await getFetch();
                 await fetch(`${DRIVER_SERVICE_URL}/find-drivers`, {
                     method: 'POST',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify({ ride: savedRide }),
                 });
                 console.log(`Simulated call to Driver Service for ride ${rideId}`);
             } catch (fetchError) {
                 logError(SERVICE_NAME, fetchError, `Simulated Driver Service call failed for ride ${rideId}`);
             }
        }

        res.status(201).json(savedRide);

    } catch (error) {
        logError(SERVICE_NAME, error, 'POST /rides');
        res.status(500).json({ message: 'Failed to request ride' });
    }
});

// Get ride status and details
app.get('/rides/:rideId', async (req, res) => {
    try {
        const ride = await Ride.findById(req.params.rideId);
        if (!ride) {
            return res.status(404).json({ message: 'Ride not found' });
        }
        res.json(ride);
    } catch (error) {
        logError(SERVICE_NAME, error, `GET /rides/${req.params.rideId}`);
        res.status(500).json({ message: 'Failed to get ride status' });
    }
});

// Get all rides (consider pagination for production)
app.get('/rides', async (req, res) => {
    try {
        // Add pagination and filtering based on query params (e.g., ?status=completed&limit=20)
        const rides = await Ride.find({}).sort({ createdAt: -1 }).limit(50); // Example: limit to last 50
        res.json(rides);
    } catch (error) {
        logError(SERVICE_NAME, error, 'GET /rides');
        res.status(500).json({ message: 'Failed to get rides' });
    }
});


// Internal endpoint to update ride status (can be called by services or Kafka consumer)
// Refactored to be more robust
app.put('/rides/:rideId/status', async (req, res) => {
    const { status, driverId, vehicleDetails, reason, fare, timestamp } = req.body; // Add reason, fare, timestamp
    const { rideId } = req.params;

    if (!status) {
        return res.status(400).json({ message: 'Missing status' });
    }

    try {
        const ride = await Ride.findById(rideId);
        if (!ride) {
            return res.status(404).json({ message: 'Ride not found' });
        }

        // Avoid overwriting final states unless explicitly needed
        const finalStates = ['completed', 'cancelled_by_rider', 'cancelled_by_driver', 'timed-out'];
        if (finalStates.includes(ride.status) && !finalStates.includes(status)) {
             console.warn(`Attempted to change status of finalized ride ${rideId} from ${ride.status} to ${status}. Ignoring.`);
             return res.status(400).json({ message: `Cannot change status of a ride that is already ${ride.status}` });
        }

        const updateData = { status };
        if (driverId) updateData.driverId = driverId;
        if (vehicleDetails) updateData.vehicleDetails = vehicleDetails;
        if (fare) updateData.fare = fare; // Store fare info if provided (e.g., on completion)

        // Optionally store reason for cancellation/timeout
        if (reason && (status.startsWith('cancelled') || status === 'timed-out')) {
            // Add a reason field to your Ride model if needed
            // updateData.reason = reason;
        }

        const updatedRide = await Ride.findByIdAndUpdate(rideId, updateData, { new: true });

        console.log(`Ride ${rideId} status updated to ${status}`);

        // If driver assigned or ride finalized, potentially remove the timeout timer
         if (['driver_assigned', ...finalStates].includes(status)) {
            const redisClient = getRedisClient();
            if (redisClient) {
                try {
                    const timerKey = `ride-timer:${rideId}`;
                    const deletedCount = await redisClient.del(timerKey);
                    if(deletedCount > 0) console.log(`Removed ride timer for finalized/assigned ride ${rideId}`);
                } catch(redisError) {
                    logError(SERVICE_NAME, redisError, `Redis Del Timer Failed for ride ${rideId}`);
                }
            }
        }

        // Note: Notifications are now primarily handled by the Kafka consumer based on events
        // published by this update or other services. Direct notification calls here are removed
        // to rely on the event-driven flow via the consumer.

        res.json(updatedRide);
    } catch (error) {
        logError(SERVICE_NAME, error, `PUT /rides/${rideId}/status`);
        res.status(500).json({ message: 'Failed to update ride status' });
    }
});


// Endpoint for OTP verification (called by Driver App)
app.post('/rides/:rideId/verify-otp', async (req, res) => {
    const { rideId } = req.params;
    const { otp } = req.body;

    // --- Basic OTP Simulation ---
    const EXPECTED_OTP = "123456"; // Hardcoded for simulation

    console.log(`Received OTP verification request for ride ${rideId} with OTP: ${otp}`);

    try {
        const ride = await Ride.findById(rideId);
        if (!ride) {
            return res.status(404).json({ message: 'Ride not found' });
        }

        if (ride.status !== 'driver_arrived') {
             return res.status(400).json({ message: 'Ride is not in the correct state (driver_arrived) for OTP verification.' });
        }

        if (otp === EXPECTED_OTP) {
            // OTP is correct, update ride status to 'in-progress'
            ride.status = 'in-progress';
            await ride.save(); // Use save to trigger pre-save hooks if any

            console.log(`OTP verified for ride ${rideId}. Status updated to in-progress.`);

            // Publish ride-update event via Kafka (Notification service will pick this up)
             const producer = getKafkaProducer();
             if (producer) {
                 try {
                    await producer.send({
                        topic: 'ride-updates',
                        messages: [{ key: rideId, value: JSON.stringify({
                            rideId: rideId,
                            status: 'in-progress',
                            riderId: ride.riderId,
                            driverId: ride.driverId,
                            timestamp: new Date().toISOString(),
                             startedAt: new Date().toISOString() // Add ride start time
                        }) }],
                    });
                    console.log(`Published ride-updates (in-progress) event for ${rideId}`);
                 } catch(kafkaError) {
                     logError(SERVICE_NAME, kafkaError, `Kafka Publish ride-updates (in-progress) Failed for ${rideId}`);
                 }
             } else {
                 console.warn("Kafka producer not connected, cannot publish ride start event.");
                 // Fallback simulation (less ideal)
                 try {
                     const fetch = await getFetch();
                     const notificationPayload = { type: 'ride_started', message: 'Your ride has started!', ride: ride };
                     await fetch(`${NOTIFICATION_SERVICE_URL}/notify/rider/${ride.riderId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(notificationPayload)});
                     await fetch(`${NOTIFICATION_SERVICE_URL}/notify/driver/${ride.driverId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(notificationPayload)});
                 } catch (fetchError) {
                      logError(SERVICE_NAME, fetchError, `Simulated notification call failed for ride start ${rideId}`);
                 }
             }

            res.json({ success: true, message: 'OTP verified, ride started.' });
        } else {
            // OTP is incorrect
            console.log(`Incorrect OTP for ride ${rideId}.`);
            res.status(400).json({ success: false, message: 'Invalid OTP.' });
        }
    } catch (error) {
        logError(SERVICE_NAME, error, `POST /rides/${rideId}/verify-otp`);
        res.status(500).json({ message: 'Failed to verify OTP.' });
    }
});


// --- Health Check ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        mongo: mongoose.connection.readyState === 1, // 1 = connected
        redis: isRedisConnected,
        kafkaProducer: isKafkaProducerConnected,
        kafkaConsumer: isKafkaConsumerConnected
    });
});

// --- Server Start ---
const PORT = process.env.RIDE_SERVICE_PORT || 3000;
app.listen(PORT, () => {
    console.log(`Ride Service listening on port ${PORT}`);
});

// Basic Error Handling Middleware
app.use((err, req, res, next) => {
  logError(SERVICE_NAME, err, 'Unhandled Route Error');
  console.error(err.stack); // Log stack trace for debugging
  res.status(500).send('Something broke!');
});
