const { Kafka, logLevel } = require('kafkajs');
const RideMetric = require('./models/RideMetric');
const DailySummary = require('./models/DailySummary');
const { logError } = require('../utils/logger');

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const SERVICE_NAME = 'analytics-service';

const kafka = new Kafka({
  clientId: SERVICE_NAME,
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 300,
    retries: 5
  }
});

let consumer = kafka.consumer({ groupId: `${SERVICE_NAME}-group` });
const producer = kafka.producer(); // Producer for sending derived events (e.g., surge alerts)

let consumerConnected = false;
let producerConnected = false;

async function connectKafka() {
    // Connect Consumer
    if (!consumerConnected) {
        if (consumer && typeof consumer.disconnect === 'function') {
            try { await consumer.disconnect(); } catch (e) { console.warn("Error disconnecting previous consumer:", e.message); }
        }
        consumer = kafka.consumer({ groupId: `${SERVICE_NAME}-group` });
        try {
            await consumer.connect();
            consumerConnected = true;
            console.log(`AnalyticsService Kafka Consumer connected successfully.`);
        } catch (error) {
            console.error(`Failed to connect AnalyticsService Kafka Consumer:`, error);
            logError(SERVICE_NAME, error, 'Kafka Consumer Connection');
            consumerConnected = false;
        }
    }

    // Connect Producer
    if (!producerConnected) {
         try {
             await producer.connect();
             producerConnected = true;
             console.log("AnalyticsService Kafka Producer connected successfully.");
         } catch (error) {
             console.error('Failed to connect AnalyticsService Kafka Producer:', error);
             logError(SERVICE_NAME, error, 'Kafka Producer Connection');
             producerConnected = false;
         }
     }

    return consumerConnected && producerConnected;
}

async function disconnectKafka() {
  try {
    if (consumerConnected) await consumer.disconnect();
    if (producerConnected) await producer.disconnect();
    consumerConnected = false;
    producerConnected = false;
    console.log("AnalyticsService Kafka clients disconnected.");
  } catch (error) {
    console.error('Error disconnecting AnalyticsService Kafka clients:', error);
    logError(SERVICE_NAME, error, 'Kafka Disconnect');
  }
}

function getKafkaConsumer() {
  if (!consumerConnected) {
    console.warn("Kafka Consumer requested but not connected.");
    return null;
  }
  return consumer;
}

function getKafkaProducer() {
    if (!producerConnected) {
      console.warn("Kafka Producer requested but not connected.");
      return null;
    }
    return producer;
  }

// --- Consumer Logic ---
async function setupAnalyticsServiceConsumer() {
    if (!consumerConnected) {
        console.warn("Cannot setup AnalyticsService consumer, Kafka not connected.");
        return;
    }

    try {
        // Subscribe to all relevant events needed for analytics
        await consumer.subscribe({ topic: 'ride-requests', fromBeginning: false });
        await consumer.subscribe({ topic: 'ride-updates', fromBeginning: false });
        await consumer.subscribe({ topic: 'payment-completed', fromBeginning: false });
        await consumer.subscribe({ topic: 'user-events', fromBeginning: false }); // For signups, etc.
        await consumer.subscribe({ topic: 'driver-events', fromBeginning: false }); // For driver online/offline status
        await consumer.subscribe({ topic: 'support-events', fromBeginning: false }); // For ticket counts, etc.

        console.log("AnalyticsService Consumer subscribed to relevant topics.");

        await consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                // console.log(`AnalyticsService received message: Topic=${topic}`); // Can be noisy
                const messageKey = message.key?.toString();
                const messageValue = message.value.toString();

                try {
                    const payload = JSON.parse(messageValue);
                    // Process the event based on topic
                    await processEventForAnalytics(topic, payload);
                    // Trigger surge pricing check periodically or based on ride request volume
                    // checkForSurgePricing(payload); // Implement this logic

                } catch (error) {
                    logError(SERVICE_NAME, error, `Error processing Kafka message from topic ${topic}`);
                }
            },
        });

        console.log("AnalyticsService consumer is running and waiting for messages...");

    } catch (error) {
        console.error('Error setting up or running AnalyticsService consumer:', error);
        logError(SERVICE_NAME, error, 'Kafka Consumer Setup/Run');
        consumerConnected = false;
    }
}

// --- Event Processing Logic ---
async function processEventForAnalytics(topic, payload) {
    try {
        const rideId = payload.rideId; // Common identifier

        switch (topic) {
            case 'ride-requests':
                if (!rideId) return;
                 await RideMetric.updateOne(
                     { rideId: rideId },
                     { $setOnInsert: {
                         rideId: rideId,
                         riderId: payload.riderId,
                         requestedAt: payload.createdAt || new Date(), // Use ride creation time
                         pickupLocation: payload.pickupLocation?.geo,
                         dropoffLocation: payload.dropoffLocation?.geo,
                         finalStatus: 'requested' // Initial status
                     }},
                     { upsert: true }
                 );
                await updateDailySummary({ $inc: { totalRidesRequested: 1 } });
                break;

            case 'ride-updates':
                if (!rideId || !payload.status) return;
                const update = { processedAt: new Date(), finalStatus: payload.status };
                if (payload.status === 'driver_assigned' && payload.assignedAt) update.assignedAt = payload.assignedAt; // Assuming Notification/Driver service adds this
                if (payload.status === 'driver_arrived' && payload.arrivedAt) update.driverArrivedAt = payload.arrivedAt;
                if (payload.status === 'in-progress' && payload.startedAt) update.startedAt = payload.startedAt;
                if (payload.status === 'completed' && payload.completedAt) update.completedAt = payload.completedAt;
                if (payload.status === 'cancelled_by_rider' || payload.status === 'cancelled_by_driver') update.cancelledAt = payload.timestamp || new Date();
                if (payload.status === 'timed-out') update.timedOutAt = payload.timestamp || new Date();
                if (payload.driverId) update.driverId = payload.driverId; // Ensure driverId is captured

                // Calculate durations when final status is reached
                if (['completed', 'cancelled_by_rider', 'cancelled_by_driver', 'timed-out'].includes(payload.status)) {
                    const metric = await RideMetric.findOne({ rideId });
                    if (metric) {
                        if (metric.requestedAt && update.assignedAt) update.pickupWaitTimeSeconds = (new Date(update.assignedAt).getTime() - new Date(metric.requestedAt).getTime()) / 1000;
                        if (update.assignedAt && update.driverArrivedAt) update.driverArrivalTimeSeconds = (new Date(update.driverArrivedAt).getTime() - new Date(update.assignedAt).getTime()) / 1000;
                        if (update.startedAt && update.completedAt) update.rideDurationSeconds = (new Date(update.completedAt).getTime() - new Date(update.startedAt).getTime()) / 1000;
                    }
                }

                await RideMetric.updateOne({ rideId: rideId }, { $set: update }, { upsert: true });

                // Update daily summary counts based on final status change
                if (payload.status === 'completed') await updateDailySummary({ $inc: { totalRidesCompleted: 1 } });
                if (payload.status === 'cancelled_by_rider') await updateDailySummary({ $inc: { totalRidesCancelledRider: 1 } });
                if (payload.status === 'cancelled_by_driver') await updateDailySummary({ $inc: { totalRidesCancelledDriver: 1 } });
                if (payload.status === 'timed-out') await updateDailySummary({ $inc: { totalRidesTimedOut: 1 } });
                break;

            case 'payment-completed':
                 if (!rideId) return;
                 const paymentUpdate = {
                     processedAt: new Date(),
                     finalStatus: 'completed' // Ensure final status is completed
                 };
                 if (payload.fare) {
                     paymentUpdate.fareAmount = payload.fare.amount;
                     paymentUpdate.fareCurrency = payload.fare.currency;
                 }
                  // Calculate durations if not already done by ride-update
                  const metricData = await RideMetric.findOne({ rideId: rideId });
                  if (metricData) {
                      if (!metricData.completedAt) paymentUpdate.completedAt = payload.timestamp || new Date(); // Set completion time if missing
                      if (metricData.requestedAt && metricData.assignedAt && !metricData.pickupWaitTimeSeconds) paymentUpdate.pickupWaitTimeSeconds = (new Date(metricData.assignedAt).getTime() - new Date(metricData.requestedAt).getTime()) / 1000;
                      if (metricData.assignedAt && metricData.driverArrivedAt && !metricData.driverArrivalTimeSeconds) paymentUpdate.driverArrivalTimeSeconds = (new Date(metricData.driverArrivedAt).getTime() - new Date(metricData.assignedAt).getTime()) / 1000;
                      if (metricData.startedAt && paymentUpdate.completedAt && !metricData.rideDurationSeconds) paymentUpdate.rideDurationSeconds = (new Date(paymentUpdate.completedAt).getTime() - new Date(metricData.startedAt).getTime()) / 1000;
                  }

                 await RideMetric.updateOne({ rideId: rideId }, { $set: paymentUpdate });
                 // Update daily earnings (only if ride wasn't already marked completed)
                 if (metricData && metricData.finalStatus !== 'completed' && paymentUpdate.fareAmount) {
                    await updateDailySummary({ $inc: { totalRidesCompleted: 1, totalEarnings: paymentUpdate.fareAmount } });
                 } else if (paymentUpdate.fareAmount){
                    await updateDailySummary({ $inc: { totalEarnings: paymentUpdate.fareAmount } });
                 }

                 break;

            // Handle other events like user signups, driver online/offline status, ratings
             case 'user-events':
                // if (payload.type === 'user_created') // increment daily signups
                // if (payload.type === 'rating_submitted' && payload.target === 'driver') // Update driver rating metrics
                break;

             case 'driver-events':
                // if (payload.type === 'driver_online') // Track online driver count
                // if (payload.type === 'driver_offline')
                break;

            default:
                // console.log(`No specific analytics processing for topic: ${topic}`);
                break;
        }
    } catch (error) {
        logError(SERVICE_NAME, error, `Error in processEventForAnalytics for topic ${topic}`);
    }
}

// --- Update Daily Summary ---
async function updateDailySummary(updateOperation) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0); // Get start of current UTC day

    try {
        await DailySummary.updateOne(
            { date: today },
            updateOperation,
            { upsert: true } // Create the document if it doesn't exist
        );
    } catch (error) {
        logError(SERVICE_NAME, error, `Error updating DailySummary for date ${today.toISOString().split('T')[0]}`);
    }
}

// --- Surge Pricing Logic (Simulation) ---
// TODO: Implement actual surge logic based on request density per area
let surgeActive = false;
async function checkForSurgePricing(eventPayload) {
     // Example: Trigger based on ride request topic
     if (eventPayload.topic !== 'ride-requests') return;

     // Simulate: Activate surge randomly or based on simple time logic
     const shouldSurge = Math.random() < 0.1; // 10% chance on each request (simple simulation)

     if (shouldSurge && !surgeActive) {
         surgeActive = true;
         const surgeMultiplier = 1.5;
         const surgeArea = "Downtown"; // Simulate a specific area
         console.log(`SURGE PRICING ACTIVATED in ${surgeArea}. Multiplier: ${surgeMultiplier}x`);

         // Publish surge event to Kafka
         if (producerConnected) {
            try {
                await getKafkaProducer().send({
                    topic: 'surge-pricing-updates',
                    messages: [{ key: surgeArea, value: JSON.stringify({ status: 'activated', multiplier: surgeMultiplier, area: surgeArea, timestamp: new Date() }) }]
                });
                // Also update daily summary
                await updateDailySummary({ $push: { surgePeriods: { startTime: new Date(), multiplier: surgeMultiplier, area: surgeArea } } });
            } catch(e) { logError(SERVICE_NAME, e, 'Publish Surge Activated Event'); }
         }

          // Simulate surge ending after some time
          setTimeout(async () => {
             if (surgeActive) { // Check if still active
                 console.log(`SURGE PRICING DEACTIVATED in ${surgeArea}.`);
                 surgeActive = false;
                 if (producerConnected) {
                    try {
                        await getKafkaProducer().send({
                            topic: 'surge-pricing-updates',
                            messages: [{ key: surgeArea, value: JSON.stringify({ status: 'deactivated', area: surgeArea, timestamp: new Date() }) }]
                        });
                        // Update end time in daily summary
                        await DailySummary.updateOne(
                           { "surgePeriods.area": surgeArea, "surgePeriods.endTime": { $exists: false } },
                           { $set: { "surgePeriods.$.endTime": new Date() } }
                        );
                    } catch(e) { logError(SERVICE_NAME, e, 'Publish Surge Deactivated Event'); }
                 }
             }
         }, 10 * 60 * 1000); // Deactivate after 10 minutes (simulation)

     }
}

// --- Kafka Publishing for Analytics Service ---
async function publishAnalyticsEvent(topic, key, data) {
    if (!producerConnected) {
        console.warn(`Kafka Producer not connected. Cannot publish analytics event: ${topic}`);
        return;
    }
    try {
        await getKafkaProducer().send({
            topic,
            messages: [{ key, value: JSON.stringify(data) }],
        });
        console.log(`Published analytics event to ${topic} for key ${key}`);
    } catch (error) {
        logError(SERVICE_NAME, error, `Failed to publish analytics event to ${topic} for key ${key}`);
    }
}


// Graceful shutdown
process.on('SIGINT', async () => {
  await disconnectKafka();
  process.exit(0);
});
process.on('SIGTERM', async () => {
    await disconnectKafka();
    process.exit(0);
});

module.exports = {
  connectKafka,
  getKafkaConsumer,
  getKafkaProducer,
  setupAnalyticsServiceConsumer,
  disconnectKafka,
  publishAnalyticsEvent, // Export publish helper if needed externally
  updateDailySummary // Export if needed for direct updates
};
