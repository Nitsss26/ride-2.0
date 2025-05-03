
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { connectRedis, getRedisClient, getRedisSubscriber } = require('./redisClient');
const { connectKafkaProducer, getKafkaProducer, connectKafkaConsumer, setupNotificationServiceConsumer } = require('./kafkaClient');
const { getFetch } = require('./fetchHelper'); // Import getFetch from fetchHelper.js
const { logError } = require('../utils/logger'); // Import logger

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const RIDE_SERVICE_URL = process.env.RIDE_SERVICE_URL || 'http://localhost:3000';
const DRIVER_SERVICE_URL = process.env.DRIVER_SERVICE_URL || 'http://localhost:3001';
const SERVICE_NAME = 'notification-service';

// Store WebSocket connections (use a Map for better performance)
const clients = new Map(); // key: userId (riderId or driverId), value: { ws: WebSocket client, subscriptions: Set<string> }

// Store active ride offers and timeouts
const activeOffers = new Map(); // key: rideId, value: { batch: [], currentDriverIndex: 0, timeoutId: null, offerTimeout: 120, rideDetails: {} }

let isRedisConnected = false;
let isKafkaProducerConnected = false;
let isKafkaConsumerConnected = false;

// --- Redis Connection ---
connectRedis().then(connected => {
    isRedisConnected = connected;
    if (connected) {
        console.log('NotificationService Redis connected (Client & Subscriber)');
        monitorRedisKeys();
    } else {
        console.warn('NotificationService Redis connection failed. Real-time features may be limited.');
        // Fallback to polling if Redis connection fails initially
        setTimeout(pollRedisKeys, 5000);
    }
}).catch(err => {
    logError(SERVICE_NAME, err, 'Redis Connection');
    setTimeout(pollRedisKeys, 5000); // Fallback polling on connection error
});


// --- Kafka Connection ---
connectKafkaProducer().then(connected => {
    isKafkaProducerConnected = connected;
    if(connected) console.log('NotificationService Kafka Producer connected');
    else console.warn('NotificationService Kafka Producer connection failed. Critical events might not be published.');
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Producer Connection'));

connectKafkaConsumer('notification-service-group').then(connected => {
    isKafkaConsumerConnected = connected;
    if (connected) {
        console.log('NotificationService Kafka Consumer connected');
        // Pass handlers for Kafka message processing
        setupNotificationServiceConsumer({ handleDriverMatch, handleRideUpdate, handlePaymentCompleted });
    } else {
        console.warn('NotificationService Kafka Consumer connection failed. Will not process events.');
    }
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Consumer Connection'));

// --- WebSocket Handling ---
wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const userId = urlParams.get('userId');

    if (!userId) {
        console.log('WebSocket connection attempt without userId. Closing.');
        ws.close(1008, "User ID is required");
        return;
    }

    console.log(`WebSocket client connected: ${userId}`);
    // Store client and initialize subscriptions set
    clients.set(userId, { ws: ws, subscriptions: new Set() });

    ws.send(JSON.stringify({ type: 'connection_ack', message: `Connected as ${userId}` }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            // console.log(`Received WebSocket message from ${userId}:`, data); // Can be noisy

            switch (data.type) {
                case 'driver_accept':
                    handleDriverAccept(userId, data.rideId);
                    break;
                case 'driver_reject':
                    handleDriverReject(userId, data.rideId, data.reason || 'Rejected');
                    break;
                case 'ping':
                    ws.send(JSON.stringify({ type: 'pong' }));
                    break;
                default:
                    console.log(`Unknown WebSocket message type from ${userId}: ${data.type}`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
            }
        } catch (error) {
            logError(SERVICE_NAME, error, `WS Message Parse/Handle Error from ${userId}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
    });

    ws.on('close', () => {
        console.log(`WebSocket client disconnected: ${userId}`);
        unsubscribeClientFromAll(userId); // Unsubscribe from Redis Pub/Sub on disconnect
        clients.delete(userId);
        // Clean up active offers for this driver if they disconnect abruptly
        clearOfferForDisconnectedDriver(userId);
    });

    ws.on('error', (error) => {
        logError(SERVICE_NAME, error, `WebSocket Error for ${userId}`);
        unsubscribeClientFromAll(userId); // Clean up subscriptions on error
        clients.delete(userId);
        clearOfferForDisconnectedDriver(userId);
    });
});

function clearOfferForDisconnectedDriver(driverId) {
     // Clean up active offers if the disconnecting client was the currently offered driver
     for (const [rideId, offer] of activeOffers.entries()) {
        if (offer.batch[offer.currentDriverIndex]?.driverId === driverId) {
            console.log(`Driver ${driverId} disconnected while being offered ride ${rideId}. Treating as rejection.`);
            // Treat disconnect during offer as a rejection/timeout
            handleDriverReject(driverId, rideId, 'Disconnected');
            break; // Assume driver can only have one active offer at a time
        }
    }
}


// --- Notification Sending Function ---
function sendNotification(userId, data) {
    const clientData = clients.get(userId);
    if (clientData && clientData.ws && clientData.ws.readyState === WebSocket.OPEN) {
        try {
            clientData.ws.send(JSON.stringify(data));
            // console.log(`Sent notification to ${userId}: ${data.type}`); // Can be noisy
            return true;
        } catch (error) {
            logError(SERVICE_NAME, error, `WS Send Error to ${userId}`);
            // Clean up broken connection
            unsubscribeClientFromAll(userId);
            clients.delete(userId);
            clearOfferForDisconnectedDriver(userId);
            return false;
        }
    } else {
        // console.log(`Client ${userId} not connected or not open. Cannot send notification.`);
        if (clientData) { // Clean up if entry exists but socket is not open
             unsubscribeClientFromAll(userId);
             clients.delete(userId);
             clearOfferForDisconnectedDriver(userId);
        }
        return false;
    }
}

// --- Kafka Message Handlers ---
async function handleDriverMatch({ rideId, batch, rideDetails }) {
    if (!rideDetails) {
        logError(SERVICE_NAME, new Error('Missing rideDetails in driver-match event'), `handleDriverMatch ${rideId}`);
        console.warn(`Received driver match for ${rideId} without rideDetails. Cannot process.`);
        return;
    }
    console.log(`Received driver match batch for ride ${rideId}. Batch size: ${batch.length}`);
    if (!batch || batch.length === 0) {
        console.log(`Empty batch received for ride ${rideId}. Publishing batch-expired.`);
        // Let Driver Service know the batch was empty/invalid
        publishKafkaEvent('batch-expired', rideId, { rideId: rideId, reason: 'Empty or invalid batch received' })
            .catch(e => logError(SERVICE_NAME, e, 'Kafka Publish batch-expired (empty)'));
        return;
    }

    // Store the batch and ride details, then start the offer process
    clearTimeout(activeOffers.get(rideId)?.timeoutId); // Clear previous offer timeout if any
    activeOffers.set(rideId, {
        batch: batch,
        rideDetails: rideDetails, // Store ride details associated with this batch
        currentDriverIndex: 0,
        offerTimeout: parseInt(process.env.DRIVER_OFFER_TIMEOUT_SECONDS || '30'),
        timeoutId: null
    });

    sendOfferToNextDriver(rideId);
}


async function handleRideUpdate({ rideId, status, riderId, driverId, vehicleDetails, message, otp }) {
    console.log(`Received ride update via Kafka for ride ${rideId}: Status ${status}`);
    const finalStates = ['completed', 'cancelled_by_rider', 'cancelled_by_driver', 'timed-out'];

    // Clean up active offer state if ride is finalized
    if (finalStates.includes(status)) {
        const offer = activeOffers.get(rideId);
        if (offer) {
            clearTimeout(offer.timeoutId);
            activeOffers.delete(rideId);
            console.log(`Cleared active offer for finalized ride ${rideId} (Status: ${status})`);
        }
         // Unsubscribe rider if they were subscribed
         if (riderId && driverId) {
            unsubscribeRiderFromLocation(riderId, driverId);
        }
    }

    // Prepare notification data
    const notificationData = {
        type: `ride_${status}`, // e.g., ride_driver_assigned
        rideId: rideId,
        message: message || `Ride status updated to ${status}.`, // Use message from event if available
         ...(driverId && { driverId }), // Include IDs if present
         ...(riderId && { riderId }),
         ...(vehicleDetails && { vehicleDetails }),
         ...(otp && { otp }) // Include OTP if provided (for driver_arrived)
    };

    // Send notifications based on status
    switch (status) {
        case 'driver_assigned':
            if (riderId) sendNotification(riderId, notificationData);
            // Notification Service already notified the driver who accepted.
            // Start location sharing
            if (riderId && driverId) subscribeRiderToLocation(riderId, driverId);
            break;
        case 'driver_arrived':
            if (riderId) sendNotification(riderId, notificationData); // Send OTP to rider
            if (driverId) sendNotification(driverId, { type: 'arrival_confirmed', rideId }); // Confirm arrival to driver
            break;
        case 'in-progress':
            if (riderId) sendNotification(riderId, { ...notificationData, type: 'ride_started', message: 'Your ride has started!' });
            if (driverId) sendNotification(driverId, { ...notificationData, type: 'ride_started', message: 'Ride is now in progress.' });
            break;
        case 'cancelled_by_rider':
             if (driverId) sendNotification(driverId, { ...notificationData, message: 'Ride cancelled by rider.' }); // Notify potentially assigned driver
             break;
         case 'cancelled_by_driver':
             if (riderId) sendNotification(riderId, { ...notificationData, message: 'Ride cancelled by driver.' }); // Notify rider
             break;
        case 'timed-out':
            if (riderId) sendNotification(riderId, { ...notificationData, message: 'Could not find a driver in time. Please try again.' });
            break;
        // No explicit notification needed for 'completed' here, handled by handlePaymentCompleted
        default:
             console.log(`No specific notification logic for ride status: ${status}`);
    }
}

async function handlePaymentCompleted({ rideId, riderId, driverId, fare }) {
    console.log(`Received payment completion via Kafka for ride ${rideId}`);
    const notificationData = {
        type: 'ride_completed',
        rideId: rideId,
        message: `Your ride is complete. Thank you!`,
        fare: fare
    };
    if (riderId) sendNotification(riderId, notificationData);
    if (driverId) {
         sendNotification(driverId, { ...notificationData, message: 'Ride complete. Payment received. You are now available.' });
          // Unsubscribe rider from driver's location
          unsubscribeRiderFromLocation(riderId, driverId);
    }
}

// --- Driver Offer Logic ---
function sendOfferToNextDriver(rideId) {
    const offer = activeOffers.get(rideId);
    if (!offer) {
        console.log(`No active offer found for ride ${rideId} to send.`);
        return;
    }

    if (offer.currentDriverIndex >= offer.batch.length) {
        console.log(`Batch exhausted for ride ${rideId}.`);
        activeOffers.delete(rideId);
        publishKafkaEvent('batch-expired', rideId, { rideId: rideId, reason: 'Batch exhausted' })
            .catch(e => logError(SERVICE_NAME, e, 'Kafka Publish batch-exhausted'));
        return;
    }

    const driverInfo = offer.batch[offer.currentDriverIndex];
    const driverId = driverInfo.driverId;
    const rideDetails = offer.rideDetails; // Get associated ride details

    console.log(`Sending offer for ride ${rideId} to driver ${driverId} (Index: ${offer.currentDriverIndex})`);

    const offerSent = sendNotification(driverId, {
        type: 'ride_offer',
        rideId: rideId,
        pickupLocation: rideDetails?.pickupLocation, // Use rideDetails from the offer map
        dropoffLocation: rideDetails?.dropoffLocation,
        estimatedFare: rideDetails?.fare, // Add fare if available in rideDetails
        timeout: offer.offerTimeout
    });

    if (offerSent) {
        offer.timeoutId = setTimeout(() => {
            console.log(`Offer timeout for driver ${driverId} for ride ${rideId}.`);
            handleDriverReject(driverId, rideId, 'Timeout');
        }, offer.offerTimeout * 1000);
        activeOffers.set(rideId, offer);
    } else {
        console.warn(`Failed to send offer to driver ${driverId}. Trying next.`);
        // Treat failure to send as an immediate rejection/timeout
        handleDriverReject(driverId, rideId, 'Failed to contact');
    }
}

function handleDriverAccept(driverId, rideId) {
    console.log(`Driver ${driverId} ACCEPTED ride ${rideId}`);
    const offer = activeOffers.get(rideId);

    if (!offer || offer.batch[offer.currentDriverIndex]?.driverId !== driverId) {
        console.warn(`Received acceptance from driver ${driverId} for ride ${rideId}, but no active/matching offer found. Ignoring.`);
        sendNotification(driverId, { type: 'offer_expired', rideId, message: 'Offer already assigned or expired.' });
        return;
    }

    clearTimeout(offer.timeoutId);

    // 1. Update Driver Status -> Let Driver Service handle this via Kafka event
    // updateDriverStatus(driverId, 'en_route_pickup', rideId); // Removed direct call

    // 2. Publish 'driver_accepted' event. Ride/Driver services react to this.
    const acceptedDriverInfo = offer.batch[offer.currentDriverIndex];
    publishKafkaEvent('driver-actions', rideId, { // Use a new topic 'driver-actions'
         type: 'driver_accepted',
         rideId: rideId,
         driverId: driverId,
         vehicleDetails: acceptedDriverInfo?.vehicle, // Send vehicle details
         timestamp: new Date().toISOString()
     }).catch(e => logError(SERVICE_NAME, e, 'Kafka Publish driver_accepted'));


    // 3. Confirm acceptance to the driver via WebSocket
    sendNotification(driverId, { type: 'offer_accepted', rideId, message: 'Offer accepted. Proceed to pickup.' });

    // 4. Clean up the active offer state for this ride
    activeOffers.delete(rideId);
}

function handleDriverReject(driverId, rideId, reason = 'Rejected') {
    console.log(`Driver ${driverId} REJECTED/TIMED OUT ride ${rideId}. Reason: ${reason}`);
    const offer = activeOffers.get(rideId);

    if (!offer) {
        // Offer might have been accepted by someone else or timed out already
        console.warn(`Received rejection/timeout from driver ${driverId} for ride ${rideId}, but no active offer found.`);
        return;
    }

     // Check if the rejection is from the currently offered driver
     if (offer.batch[offer.currentDriverIndex]?.driverId === driverId) {
        clearTimeout(offer.timeoutId);
        offer.timeoutId = null;

        // Publish 'driver_rejected' event (optional, but good for analytics)
        publishKafkaEvent('driver-actions', rideId, {
             type: 'driver_rejected',
             rideId: rideId,
             driverId: driverId,
             reason: reason,
             timestamp: new Date().toISOString()
         }).catch(e => logError(SERVICE_NAME, e, 'Kafka Publish driver_rejected'));

        // Move to the next driver
        offer.currentDriverIndex++;
        activeOffers.set(rideId, offer);
        sendOfferToNextDriver(rideId);
     } else {
         console.warn(`Received rejection from driver ${driverId} but they are not the current driver offered for ride ${rideId}. Ignoring.`);
     }
}

// --- Redis Key Monitoring ---
async function monitorRedisKeys() {
    const subscriber = getRedisSubscriber(); // Use the dedicated subscriber client
    if (!subscriber || !isRedisConnected) {
         console.warn("Redis subscriber client not available or not connected. Falling back to polling Redis keys.");
         setTimeout(pollRedisKeys, 5000); // Start polling as fallback
         return;
     }
    console.log("Attempting to subscribe to Redis keyspace events...");

    try {
        await subscriber.subscribe('__keyevent@0__:expired', (message, channel) => {
            // console.log(`Redis Keyspace Event: ${channel} -> Key: ${message}`); // Can be noisy
            if (message.startsWith('ride-timer:')) {
                const rideId = message.split(':')[1];
                handleRideTimeout(rideId);
            } else if (message.startsWith('driver-batch:')) {
                const rideId = message.split(':')[1];
                handleBatchTimeout(rideId);
            }
        });
        console.log("Successfully subscribed to Redis keyspace expired events.");
    } catch (error) {
        logError(SERVICE_NAME, error, "Redis Keyspace Subscription Failed");
        console.error("Error subscribing to Redis keyspace events. Falling back to polling.");
        // Unsubscribe might be needed if partially subscribed before error
        try { await subscriber.unsubscribe('__keyevent@0__:expired'); } catch (unsubError) {/* ignore */}
        setTimeout(pollRedisKeys, 5000); // Fallback to polling
    }
}

// Fallback Polling Function
let pollTimeoutId = null;
async function pollRedisKeys() {
    clearTimeout(pollTimeoutId); // Clear previous timeout if exists
    if (!isRedisConnected) {
        console.warn("Polling stopped: Redis not connected.");
        // Attempt to reconnect Redis? Or just wait?
        // Let's retry polling after a delay
        pollTimeoutId = setTimeout(pollRedisKeys, 15000); // Retry polling after 15s
        return;
    }
    const redisClient = getRedisClient();
    if (!redisClient) {
         pollTimeoutId = setTimeout(pollRedisKeys, 15000); // Retry polling after 15s
         return;
    }

    try {
        // Use SCAN instead of KEYS for better performance in production
        let cursor = '0';
        do {
            const reply = await redisClient.scan(cursor, { MATCH: 'ride-timer:*', COUNT: 100 });
            cursor = reply.cursor;
            const keys = reply.keys;
            for (const key of keys) {
                try {
                     const ttl = await redisClient.ttl(key);
                     if (ttl === -2) { // Key expired / doesn't exist
                         const rideId = key.split(':')[1];
                         handleRideTimeout(rideId);
                         // No need to DEL, TTL handles it.
                     }
                } catch(keyError) { logError(SERVICE_NAME, keyError, `Polling TTL check failed for key ${key}`); }
            }
        } while (cursor !== '0');

        cursor = '0';
         do {
             const reply = await redisClient.scan(cursor, { MATCH: 'driver-batch:*', COUNT: 100 });
             cursor = reply.cursor;
             const keys = reply.keys;
             for (const key of keys) {
                  try {
                      const ttl = await redisClient.ttl(key);
                      if (ttl === -2) {
                          const rideId = key.split(':')[1];
                          handleBatchTimeout(rideId);
                      }
                  } catch(keyError) { logError(SERVICE_NAME, keyError, `Polling TTL check failed for key ${key}`); }
             }
         } while (cursor !== '0');

    } catch (error) {
        logError(SERVICE_NAME, error, "Polling Redis Keys Error");
    } finally {
        // Schedule next poll
        pollTimeoutId = setTimeout(pollRedisKeys, 5000); // Poll again in 5 seconds
    }
}

function handleRideTimeout(rideId) {
    console.log(`Ride timer expired for ride ${rideId}.`);
    const offer = activeOffers.get(rideId);
    if (offer) {
        clearTimeout(offer.timeoutId);
        activeOffers.delete(rideId);
        console.log(`Cleared active offer due to ride timeout for ride ${rideId}`);
    }
    // Publish ride-timeout event via Kafka -> Ride Service consumes this
    publishKafkaEvent('ride-updates', rideId, { rideId, status: 'timed-out', reason: '10 minute limit reached', timestamp: new Date().toISOString() })
        .catch(e => logError(SERVICE_NAME, e, 'Kafka Publish ride-timed-out'));
}

function handleBatchTimeout(rideId) {
    console.log(`Driver batch TTL expired for ride ${rideId}.`);
    const offer = activeOffers.get(rideId);
    if (offer) {
        console.log(`Batch timed out, but an offer is still active for ride ${rideId}. Allowing driver response timeout to handle.`);
        // Let the driver_reject timeout handle the progression
    } else {
         // If no offer is active (all drivers rejected/timed out or batch was invalid)
         console.log(`No active offer for ride ${rideId} upon batch expiry. Publishing batch-expired event.`);
         publishKafkaEvent('batch-expired', rideId, { rideId: rideId, reason: 'Batch TTL expired' })
            .catch(e => logError(SERVICE_NAME, e, 'Kafka Publish batch-expired (TTL)'));
    }
}

// --- Location Subscription ---
async function subscribeRiderToLocation(riderId, driverId) {
    const subscriber = getRedisSubscriber();
    if (!subscriber || !isRedisConnected) {
        console.warn(`Cannot subscribe rider ${riderId} to location updates: Redis subscriber not available or not connected.`);
        return;
    }

    const channel = `driver-location-updates:${driverId}`;
    const clientData = clients.get(riderId);

    if (!clientData || !clientData.ws || clientData.ws.readyState !== WebSocket.OPEN) {
        console.log(`Rider ${riderId} not connected. Cannot subscribe to location updates for driver ${driverId}.`);
        return;
    }
    if (clientData.subscriptions.has(channel)) {
        // console.log(`Rider ${riderId} already subscribed to ${channel}`);
        return; // Already subscribed
    }

    try {
        // Define message handler specific to this subscription & client
         const messageHandler = (message, msgChannel) => {
              if (msgChannel === channel) {
                  const currentClientData = clients.get(riderId); // Re-check client exists before sending
                  if (currentClientData && currentClientData.ws.readyState === WebSocket.OPEN) {
                      try {
                          const locationData = JSON.parse(message);
                          sendNotification(riderId, { // Use sendNotification for safety
                              type: 'driver_location_update',
                              rideId: locationData.rideId,
                              driverId: driverId,
                              location: locationData.location
                          });
                      } catch (e) {
                          logError(SERVICE_NAME, e, `Error parsing/sending location update for rider ${riderId} from channel ${channel}`);
                      }
                  } else {
                       // If client disconnected while subscribed, attempt cleanup (though close handler should also catch this)
                       console.warn(`Client ${riderId} disconnected, but received message on ${channel}. Attempting unsubscribe.`);
                       unsubscribeRiderFromLocation(riderId, driverId);
                  }
              }
          };

        // Associate handler with the client for potential removal later
        clientData.locationHandler = messageHandler;

        await subscriber.subscribe(channel, messageHandler);
        clientData.subscriptions.add(channel);
        console.log(`Rider ${riderId} subscribed to location updates for driver ${driverId} on channel ${channel}`);

    } catch (error) {
        logError(SERVICE_NAME, error, `Error subscribing rider ${riderId} to channel ${channel}`);
    }
}

async function unsubscribeRiderFromLocation(riderId, driverId) {
    const subscriber = getRedisSubscriber();
    if (!subscriber || !isRedisConnected) return;

    const channel = `driver-location-updates:${driverId}`;
    const clientData = clients.get(riderId);

    try {
         // Use pUnsubscribe or unsubscribe based on how you subscribed initially
         // If using individual handlers per client, managing unsubscription becomes complex.
         // A simpler approach for this service might be to have ONE handler for the channel
         // that then looks up the rider WS based on the driverId->rideId->riderId mapping,
         // but that requires more state management here.
         // Current approach: We just remove the subscription tracking from the clientData.
         // The actual Redis subscription might persist until the subscriber client restarts,
         // but the handler checks if the client is still valid.

         if (clientData && clientData.subscriptions.has(channel)) {
            // Optional: If you associated the handler: subscriber.unsubscribe(channel, clientData.locationHandler);
            await subscriber.unsubscribe(channel); // General unsubscribe from channel if using shared handler
            clientData.subscriptions.delete(channel);
            delete clientData.locationHandler; // Remove handler reference
            console.log(`Rider ${riderId} unsubscribed from location updates for driver ${driverId} on channel ${channel}`);
         }
    } catch (error) {
        logError(SERVICE_NAME, error, `Error unsubscribing rider ${riderId} from channel ${channel}`);
    }
}

// Unsubscribe a client from all their Redis subscriptions
async function unsubscribeClientFromAll(userId) {
    const clientData = clients.get(userId);
    if (clientData && clientData.subscriptions && clientData.subscriptions.size > 0) {
        const subscriber = getRedisSubscriber();
        if (subscriber && isRedisConnected) {
            console.log(`Unsubscribing client ${userId} from channels:`, Array.from(clientData.subscriptions));
             try {
                 // Unsubscribe from all tracked channels for this client
                 // Note: This might unsubscribe other clients if using a shared handler per channel.
                 // A more robust approach might involve reference counting per channel.
                 await subscriber.unsubscribe(Array.from(clientData.subscriptions));
             } catch (error) {
                  logError(SERVICE_NAME, error, `Error unsubscribing client ${userId} from channels`);
             }
        }
        clientData.subscriptions.clear(); // Clear tracked subscriptions regardless
    }
}


// --- Helper Functions for Cross-Service Communication ---
async function publishKafkaEvent(topic, key, data) {
    const producer = getKafkaProducer();
    if (!producer) {
        console.warn(`Kafka Producer not connected. Cannot publish ${topic} event for key ${key}.`);
        return; // Don't proceed without Kafka for critical events
    }
    try {
        await producer.send({
            topic: topic,
            messages: [{ key: key, value: JSON.stringify(data) }],
        });
        // console.log(`Published ${topic} event for key ${key}`); // Can be noisy
    } catch (error) {
        logError(SERVICE_NAME, error, `Kafka Publish Failed - Topic: ${topic}, Key: ${key}`);
    }
}

// Removed direct call to updateDriverStatus - rely on Kafka events

async function publishRideUpdate(rideId, updateData) {
    // Helper specifically for publishing to 'ride-updates' topic
    await publishKafkaEvent('ride-updates', rideId, { rideId, ...updateData, timestamp: new Date().toISOString() });
}


// --- API Endpoints (for direct notification simulation/testing - Keep for testing) ---
app.post('/notify/user/:userId', (req, res) => { // Renamed from /rider/
    const { userId } = req.params;
    const notificationData = req.body;
    console.log(`Received direct notification request for user ${userId}`);
    const success = sendNotification(userId, notificationData);
    if (success) {
        res.status(200).json({ message: 'Notification sent' });
    } else {
        res.status(404).json({ message: 'User not connected' });
    }
});

app.post('/notify/driver/:driverId', (req, res) => { // Keep specific driver endpoint if needed
    const { driverId } = req.params;
    const notificationData = req.body;
     console.log(`Received direct notification request for driver ${driverId}`);
    const success = sendNotification(driverId, notificationData);
    if (success) {
        res.status(200).json({ message: 'Notification sent' });
    } else {
        res.status(404).json({ message: 'Driver not connected' });
    }
});

// Endpoint to simulate receiving a batch (for testing without Kafka)
app.post('/notify/drivers', (req, res) => {
     const { rideId, batch, rideDetails } = req.body; // Expect rideDetails now
     console.log(`Received direct batch notification request for ride ${rideId}`);
     if (!rideId || !batch || !rideDetails) {
         return res.status(400).json({ message: 'Missing rideId, batch, or rideDetails' });
     }
     // Manually call the handler function
     handleDriverMatch({ rideId, batch, rideDetails });
     res.status(200).json({ message: 'Batch processing initiated' });
 });

 // Endpoint to notify a group (e.g., support alerts) - Simple broadcast for now
 app.post('/notify/group/:groupId', (req, res) => {
    const { groupId } = req.params;
    const notificationData = req.body;
    console.log(`Received notification request for group ${groupId}`);
    let count = 0;
    // In a real system, you'd look up members of the group
    // Here, we just broadcast to all connected clients for demo (use with caution!)
    clients.forEach((clientData, userId) => {
       // Add logic here to filter by group if possible (e.g., based on user role)
       if (sendNotification(userId, notificationData)) {
           count++;
       }
    });
    res.status(200).json({ message: `Broadcast attempt to group ${groupId} (Sent to ${count} clients).` });
});

// --- Health Check ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        redis: isRedisConnected,
        kafkaProducer: isKafkaProducerConnected,
        kafkaConsumer: isKafkaConsumerConnected,
        activeWebSockets: clients.size
    });
});

// --- Server Start ---
const PORT = process.env.NOTIFICATION_SERVICE_PORT || 3002;
server.listen(PORT, () => {
    console.log(`Notification Service (including WebSocket Server) listening on port ${PORT}`);
});

// Basic Error Handling Middleware
app.use((err, req, res, next) => {
  logError(SERVICE_NAME, err, 'Unhandled Route Error');
  console.error(err.stack);
  res.status(500).send('Something broke!');
});
