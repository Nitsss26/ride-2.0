require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { connectKafka, setupAnalyticsServiceConsumer, updateDailySummary } = require('./kafkaClient');
const { logError } = require('../utils/logger');
const DailySummary = require('./models/DailySummary');
const RideMetric = require('./models/RideMetric'); // Import RideMetric

const app = express();
app.use(express.json());

const MONGODB_URI = process.env.ANALYTICS_SERVICE_MONGODB_URI || 'mongodb://localhost:27017/analytics_service';
const SERVICE_NAME = 'analytics-service';

let isKafkaConnected = false;

// --- Database Connection ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log('AnalyticsService MongoDB connected'))
  .catch(err => {
      console.error('AnalyticsService MongoDB connection error:', err);
      logError(SERVICE_NAME, err, 'MongoDB Connection');
      process.exit(1); // Exit if DB fails
  });

// --- Kafka Connection & Setup ---
connectKafka().then(connected => {
    isKafkaConnected = connected;
    if (connected) {
        console.log('AnalyticsService Kafka clients connected');
        setupAnalyticsServiceConsumer().catch(err => logError(SERVICE_NAME, err, "Kafka Consumer Setup"));
    } else {
        console.warn('AnalyticsService Kafka Consumer or Producer connection failed. Service might not function correctly.');
    }
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Connection'));


// --- API Endpoints ---

// Get Today's Summary Metrics
app.get('/analytics/summary/today', async (req, res) => {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0); // Start of current UTC day

    try {
        let summary = await DailySummary.findOne({ date: today });
        if (!summary) {
             // If no summary exists for today yet, create a default one
             summary = new DailySummary({ date: today });
             await updateDailySummary({}); // Ensures creation if needed via upsert
             summary = await DailySummary.findOne({ date: today }); // Fetch again
         }
        res.status(200).json(summary || { date: today, message: "No data processed yet for today." });
    } catch (error) {
        logError(SERVICE_NAME, error, 'Get Today Summary');
        res.status(500).json({ message: 'Failed to retrieve today\'s summary metrics' });
    }
});

// Get Summary Metrics for a Specific Date
app.get('/analytics/summary/:date', async (req, res) => {
    const { date } = req.params; // Expecting YYYY-MM-DD format
    try {
        const targetDate = new Date(date);
        if (isNaN(targetDate.getTime())) {
            return res.status(400).json({ message: 'Invalid date format. Use YYYY-MM-DD.' });
        }
        targetDate.setUTCHours(0, 0, 0, 0);

        const summary = await DailySummary.findOne({ date: targetDate });
        if (!summary) {
            return res.status(404).json({ message: `No summary found for date ${date}` });
        }
        res.status(200).json(summary);
    } catch (error) {
        logError(SERVICE_NAME, error, `Get Summary for Date ${date}`);
        res.status(500).json({ message: 'Failed to retrieve summary metrics' });
    }
});

// Get Recent Ride Metrics (e.g., last 10 completed rides)
app.get('/analytics/rides/recent', async (req, res) => {
    const limit = parseInt(req.query.limit) || 10;
    try {
        const recentRides = await RideMetric.find({ finalStatus: 'completed' })
                                           .sort({ completedAt: -1 })
                                           .limit(limit);
        res.status(200).json(recentRides);
    } catch (error) {
        logError(SERVICE_NAME, error, 'Get Recent Ride Metrics');
        res.status(500).json({ message: 'Failed to retrieve recent ride metrics' });
    }
});

// Get Metrics for a Specific Ride
app.get('/analytics/rides/:rideId', async (req, res) => {
    const { rideId } = req.params;
    try {
        const rideMetric = await RideMetric.findOne({ rideId: rideId });
        if (!rideMetric) {
            return res.status(404).json({ message: `Metrics not found for ride ${rideId}` });
        }
        res.status(200).json(rideMetric);
    } catch (error) {
        logError(SERVICE_NAME, error, `Get Ride Metrics ${rideId}`);
        res.status(500).json({ message: 'Failed to retrieve ride metrics' });
    }
});


// --- Health Check ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        mongo: mongoose.connection.readyState === 1,
        kafka: isKafkaConnected // Indicates if both consumer/producer are connected (or as needed)
    });
});

// --- Server Start ---
const PORT = process.env.ANALYTICS_SERVICE_PORT || 3008;
app.listen(PORT, () => {
    console.log(`Analytics Service listening on port ${PORT}`);
});

// Basic Error Handling Middleware
app.use((err, req, res, next) => {
  logError(SERVICE_NAME, err, 'Unhandled Route Error');
  res.status(500).send('Something broke!');
});
