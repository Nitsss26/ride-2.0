require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { connectKafkaConsumer, setupUserServiceConsumer } = require('./kafkaClient');
const UserProfile = require('./models/UserProfile');
const { logError } = require('../utils/logger'); // Import logger
const { getFetch } = require('./fetchHelper'); // Use fetch helper

const app = express();
app.use(express.json());

const MONGODB_URI = process.env.USER_SERVICE_MONGODB_URI || 'mongodb://localhost:27017/user_service';
const DRIVER_SERVICE_URL = process.env.DRIVER_SERVICE_URL || 'http://localhost:3001';
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3005';

let isKafkaConsumerConnected = false;
const SERVICE_NAME = 'user-service';

// --- Database Connection ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log('UserService MongoDB connected'))
  .catch(err => {
      console.error('UserService MongoDB connection error:', err);
      logError(SERVICE_NAME, err, 'MongoDB Connection');
      process.exit(1); // Exit if DB fails
  });

// --- Kafka Consumer Connection & Setup ---
connectKafkaConsumer(`${SERVICE_NAME}-group`).then(connected => {
    isKafkaConsumerConnected = connected;
    if (connected) {
        console.log('UserService Kafka Consumer connected');
        setupUserServiceConsumer().catch(err => logError(SERVICE_NAME, err, "Kafka Consumer Setup"));
    } else {
        console.warn('UserService Kafka Consumer connection failed. Will not process user events.');
    }
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Consumer Connection'));

// --- API Endpoints ---

// Get User Profile
app.get('/users/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const userProfile = await UserProfile.findById(userId);
        if (!userProfile) {
            // Attempt to fetch basic info from Auth service as a fallback or sync mechanism
             try {
                 const fetch = await getFetch();
                 const authRes = await fetch(`${AUTH_SERVICE_URL}/users/${userId}`); // Assume an endpoint exists in Auth Service
                 if (authRes.ok) {
                     const authUser = await authRes.json();
                     // Create a basic profile based on auth data
                     const newProfile = new UserProfile({
                         _id: authUser._id,
                         email: authUser.email,
                         role: authUser.role,
                         isVerified: authUser.isVerified,
                         accountStatus: authUser.isVerified ? (authUser.role === 'driver' ? 'pending_approval' : 'active') : 'pending_verification'
                     });
                     await newProfile.save();
                     console.log(`Created missing profile for user ${userId} based on Auth Service data.`);
                     return res.status(200).json(newProfile);
                 }
             } catch (fetchError) {
                 logError(SERVICE_NAME, fetchError, `Fallback auth fetch for user ${userId}`);
             }
            // If fetch fails or auth service doesn't have the user, return 404
            return res.status(404).json({ message: 'User profile not found' });
        }
        res.status(200).json(userProfile);
    } catch (error) {
        logError(SERVICE_NAME, error, `Get User Profile ${userId}`);
        res.status(500).json({ message: 'Server error fetching user profile' });
    }
});

// Update User Profile
app.put('/users/:userId', async (req, res) => {
    const { userId } = req.params;
    const updateData = req.body;

    // Prevent critical fields from being updated directly via this endpoint
    delete updateData._id;
    delete updateData.email;
    delete updateData.role;
    delete updateData.isVerified;
    delete updateData.accountStatus; // Status managed by events or admin

    try {
        const updatedProfile = await UserProfile.findByIdAndUpdate(
            userId,
            { $set: updateData },
            { new: true, runValidators: true }
        );

        if (!updatedProfile) {
            return res.status(404).json({ message: 'User profile not found' });
        }

        // If driver details were updated, potentially notify Driver Service
        if (updateData.driverDetails?.vehicleInfo && updatedProfile.role === 'driver') {
            console.log(`Driver ${userId} vehicle info updated, consider notifying Driver Service`);
            // Add Kafka event or direct call if Driver Service needs this info immediately
        }

        res.status(200).json(updatedProfile);
    } catch (error) {
        logError(SERVICE_NAME, error, `Update User Profile ${userId}`);
        res.status(500).json({ message: 'Server error updating user profile' });
    }
});

// Internal endpoint for creating/syncing user profiles based on Kafka events or direct calls
app.post('/users/sync', async (req, res) => {
    const { userId, email, role, action } = req.body; // action: 'create' | 'verify' | 'update_status'
    console.log(`Received sync request for user ${userId}, action: ${action}`);

    if (!userId || !action) {
        return res.status(400).json({ message: 'Missing userId or action for sync' });
    }

    try {
        if (action === 'create' && email && role) {
             await UserProfile.findByIdAndUpdate(
                 userId,
                 { $setOnInsert: { _id: userId, email, role, accountStatus: role === 'driver' ? 'pending_approval' : 'pending_verification' } },
                 { upsert: true, new: true }
             );
            console.log(`Synced: Created profile for ${userId}`);
        } else if (action === 'verify') {
             await UserProfile.updateOne(
                 { _id: userId, accountStatus: 'pending_verification' },
                 { $set: { isVerified: true, accountStatus: 'active' } }
             );
             await UserProfile.updateOne(
                { _id: userId, role: 'driver', accountStatus: 'pending_approval' },
                { $set: { isVerified: true } }
            );
             console.log(`Synced: Verified profile for ${userId}`);
        } else if (action === 'update_status' && req.body.accountStatus) {
             await UserProfile.findByIdAndUpdate(userId, { accountStatus: req.body.accountStatus });
             console.log(`Synced: Updated status for ${userId} to ${req.body.accountStatus}`);
         }
        else {
            return res.status(400).json({ message: 'Invalid sync action or missing data' });
        }
        res.status(200).json({ message: `Sync action '${action}' processed for user ${userId}` });
    } catch (error) {
        logError(SERVICE_NAME, error, `Sync User Profile ${userId} Action: ${action}`);
        res.status(500).json({ message: 'Server error during profile sync' });
    }
});

// Internal endpoint to update user status (e.g., called by Kafka handler)
app.put('/users/:userId/status', async (req, res) => {
    const { userId } = req.params;
    const { isVerified, accountStatus } = req.body;
    console.log(`Received status update request for user ${userId}:`, req.body);

    try {
        const update = {};
        if (isVerified !== undefined) update.isVerified = isVerified;
        if (accountStatus !== undefined) update.accountStatus = accountStatus;

        if (Object.keys(update).length === 0) {
            return res.status(400).json({ message: 'No status fields provided for update' });
        }

        const updatedProfile = await UserProfile.findByIdAndUpdate(
            userId,
            { $set: update },
            { new: true }
        );

        if (!updatedProfile) {
            return res.status(404).json({ message: 'User profile not found' });
        }
        res.status(200).json({ message: 'User status updated successfully', profile: updatedProfile });
    } catch (error) {
        logError(SERVICE_NAME, error, `Update User Status ${userId}`);
        res.status(500).json({ message: 'Server error updating user status' });
    }
});


// --- Health Check ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        mongo: mongoose.connection.readyState === 1,
        kafkaConsumer: isKafkaConsumerConnected
    });
});

// --- Server Start ---
const PORT = process.env.USER_SERVICE_PORT || 3006;
app.listen(PORT, () => {
    console.log(`User Service listening on port ${PORT}`);
});

// Basic Error Handling Middleware
app.use((err, req, res, next) => {
  logError(SERVICE_NAME, err, 'Unhandled Route Error');
  res.status(500).send('Something broke!');
});
