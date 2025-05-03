require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { connectKafkaProducer, publishUserEvent } = require('./kafkaClient');
const { logError } = require('../utils/logger'); // Import logger
const User = require('./models/User');
const { getFetch } = require('./fetchHelper'); // Use fetch helper

const app = express();
app.use(express.json());

const MONGODB_URI = process.env.AUTH_SERVICE_MONGODB_URI || 'mongodb://localhost:27017/auth_service';
const JWT_SECRET = process.env.JWT_SECRET || 'YourSuperSecretKeyForJWT'; // Use a strong secret in production
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3006';

let isKafkaProducerConnected = false;
const SERVICE_NAME = 'auth-service';

// --- Database Connection ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log('AuthService MongoDB connected'))
  .catch(err => {
    console.error('AuthService MongoDB connection error:', err);
    logError(SERVICE_NAME, err, 'MongoDB Connection');
    process.exit(1); // Exit if DB connection fails
  });

// --- Kafka Connection ---
connectKafkaProducer().then(connected => {
    isKafkaProducerConnected = connected;
    if (connected) console.log('AuthService Kafka Producer connected');
    else console.warn('AuthService Kafka Producer connection failed. User events will not be published.');
}).catch(err => {
    logError(SERVICE_NAME, err, 'Kafka Producer Connection');
    console.error('AuthService Kafka Producer connection error:', err);
    // Continue running, but log the warning
});

// --- API Endpoints ---

// User Registration
app.post('/register', async (req, res) => {
    const { email, password, role = 'rider' } = req.body; // Default role to rider

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
    }
    if (!['rider', 'driver'].includes(role)) {
        return res.status(400).json({ message: 'Invalid role specified. Must be rider or driver.' });
    }

    try {
        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(409).json({ message: 'Email already in use' });
        }

        // Create new user
        const newUser = new User({ email, password, role });

        // Generate verification code (example)
        const verificationCode = newUser.createVerificationCode();
        await newUser.save();

        // TODO: Send verification code via email/SMS (Simulated here)
        console.log(`Verification code for ${email}: ${verificationCode}`);

        // Publish user_created event (asynchronous)
        if (isKafkaProducerConnected) {
            publishUserEvent('user_created', newUser).catch(err => logError(SERVICE_NAME, err, 'Kafka Publish user_created'));
        } else {
             // Fallback: Directly call User Service (less ideal)
             try {
                 const fetch = await getFetch();
                 await fetch(`${USER_SERVICE_URL}/users/sync`, {
                     method: 'POST',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify({ userId: newUser._id, email: newUser.email, role: newUser.role, action: 'create' }),
                 });
                 console.log(`Simulated call to User Service for user creation: ${newUser._id}`);
             } catch (fetchError) {
                 logError(SERVICE_NAME, fetchError, `Fallback User Service call failed for user ${newUser._id}`);
             }
        }

        res.status(201).json({ message: 'User registered successfully. Please verify your email.', userId: newUser._id });

    } catch (error) {
        logError(SERVICE_NAME, error, 'Registration');
        if (error.code === 11000) { // Duplicate key error
            return res.status(409).json({ message: 'Email already in use' });
        }
        res.status(500).json({ message: 'Server error during registration' });
    }
});

// Email Verification
app.post('/verify', async (req, res) => {
    const { email, code } = req.body;

    if (!email || !code) {
        return res.status(400).json({ message: 'Email and verification code are required' });
    }

    try {
        const user = await User.findOne({ email }).select('+verificationCode +verificationCodeExpires');
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        if (user.isVerified) {
            return res.status(400).json({ message: 'Account already verified' });
        }
        if (user.verificationCode !== code || user.verificationCodeExpires < new Date()) {
            return res.status(400).json({ message: 'Invalid or expired verification code' });
        }

        // Mark as verified and clear verification fields
        user.isVerified = true;
        user.verificationCode = undefined;
        user.verificationCodeExpires = undefined;
        await user.save();

         // Publish user_verified event
         if (isKafkaProducerConnected) {
            publishUserEvent('user_verified', user).catch(err => logError(SERVICE_NAME, err, 'Kafka Publish user_verified'));
        } else {
             // Fallback: Directly call User Service
             try {
                 const fetch = await getFetch();
                 await fetch(`${USER_SERVICE_URL}/users/${user._id}/status`, {
                     method: 'PUT',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify({ isVerified: true }),
                 });
                 console.log(`Simulated call to User Service for user verification: ${user._id}`);
             } catch (fetchError) {
                 logError(SERVICE_NAME, fetchError, `Fallback User Service verification call failed for user ${user._id}`);
             }
        }

        res.status(200).json({ message: 'Account verified successfully' });

    } catch (error) {
        logError(SERVICE_NAME, error, 'Verification');
        res.status(500).json({ message: 'Server error during verification' });
    }
});

// User Login
app.post('/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required' });
    }

    try {
        const user = await User.findOne({ email }).select('+password'); // Include password for comparison
        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Compare password
        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        if (!user.isVerified) {
            return res.status(403).json({ message: 'Account not verified. Please check your email.' });
        }

        // Generate JWT
        const payload = {
            userId: user._id,
            role: user.role,
            email: user.email
        };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '1d' }); // Token expires in 1 day

        res.status(200).json({
            message: 'Login successful',
            token: token,
            user: { // Send back basic user info (without password)
                id: user._id,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        logError(SERVICE_NAME, error, 'Login');
        res.status(500).json({ message: 'Server error during login' });
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
const PORT = process.env.AUTH_SERVICE_PORT || 3005;
app.listen(PORT, () => {
    console.log(`Auth Service listening on port ${PORT}`);
});

// Basic Error Handling Middleware (Optional)
app.use((err, req, res, next) => {
  logError(SERVICE_NAME, err, 'Unhandled Route Error');
  res.status(500).send('Something broke!');
});
