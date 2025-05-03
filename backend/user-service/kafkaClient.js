const { Kafka, logLevel } = require('kafkajs');
const UserProfile = require('./models/UserProfile');
const { logError } = require('../utils/logger');

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const SERVICE_NAME = 'user-service';

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
let consumerConnected = false;

async function connectKafkaConsumer(groupId = `${SERVICE_NAME}-group`) {
  if (consumerConnected) return true;
  if (!consumerConnected) {
      if (consumer && typeof consumer.disconnect === 'function') {
          try { await consumer.disconnect(); } catch (e) { console.warn("Error disconnecting previous consumer:", e.message); }
      }
      consumer = kafka.consumer({ groupId });
  }
  try {
    await consumer.connect();
    consumerConnected = true;
    console.log(`UserService Kafka Consumer connected successfully (Group ID: ${groupId}).`);
    return true;
  } catch (error) {
    console.error(`Failed to connect UserService Kafka Consumer (Group ID: ${groupId}):`, error);
    logError(SERVICE_NAME, error, 'Kafka Consumer Connection');
    consumerConnected = false;
    return false;
  }
}

async function disconnectKafka() {
  try {
    if (consumerConnected) await consumer.disconnect();
    consumerConnected = false;
    console.log("UserService Kafka consumer disconnected.");
  } catch (error) {
    console.error('Error disconnecting UserService Kafka consumer:', error);
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

// --- Consumer Logic ---
async function setupUserServiceConsumer() {
    if (!consumerConnected) {
        console.warn("Cannot setup UserService consumer, Kafka not connected.");
        return;
    }

    try {
        await consumer.subscribe({ topic: 'user-events', fromBeginning: false });
        await consumer.subscribe({ topic: 'driver-updates', fromBeginning: false }); // Listen for driver approvals/info changes

        console.log("UserService Consumer subscribed to topics: user-events, driver-updates");

        await consumer.run({
            eachMessage: async ({ topic, partition, message }) => {
                console.log(`UserService received message: Topic=${topic}, Partition=${partition}`);
                const messageKey = message.key?.toString(); // userId
                const messageValue = message.value.toString();

                try {
                    const payload = JSON.parse(messageValue);
                    const userId = messageKey || payload.userId;

                    if (!userId) {
                        console.warn(`Skipping message from topic ${topic}: Missing userId/key.`);
                        return;
                    }

                    console.log(`Processing message for userId: ${userId} from topic: ${topic}`);

                    switch (topic) {
                        case 'user-events':
                            await handleUserEvent(payload);
                            break;
                        case 'driver-updates':
                             await handleDriverUpdate(payload);
                             break;
                        // Add cases for other relevant topics if needed
                        default:
                            console.log(`UserService received message from unhandled topic: ${topic}`);
                    }
                } catch (error) {
                    logError(SERVICE_NAME, error, `Error processing Kafka message from topic ${topic}`);
                }
            },
        });

        console.log("UserService consumer is running and waiting for messages...");

    } catch (error) {
        console.error('Error setting up or running UserService consumer:', error);
        logError(SERVICE_NAME, error, 'Kafka Consumer Setup/Run');
        consumerConnected = false;
    }
}

// --- Event Handlers ---
async function handleUserEvent(payload) {
    const { type, userId, email, role } = payload;
    try {
        switch (type) {
            case 'user_created':
                console.log(`Handling user_created event for userId: ${userId}`);
                // Create a basic profile if it doesn't exist
                await UserProfile.findByIdAndUpdate(
                    userId,
                    {
                        $setOnInsert: { // Only set these fields on insert
                           _id: userId,
                            email: email,
                            role: role,
                            accountStatus: role === 'driver' ? 'pending_approval' : 'pending_verification' // Drivers need approval
                         }
                    },
                    { upsert: true, new: true } // Create if not exists
                );
                console.log(`User profile created/ensured for userId: ${userId}`);
                break;

            case 'user_verified':
                console.log(`Handling user_verified event for userId: ${userId}`);
                // Update profile status if it was pending verification
                await UserProfile.updateOne(
                    { _id: userId, accountStatus: 'pending_verification' }, // Condition: only update if pending
                    { $set: { isVerified: true, accountStatus: 'active' } } // Set verified and active
                );
                 // If driver, status remains pending_approval until admin approves
                 await UserProfile.updateOne(
                      { _id: userId, role: 'driver', accountStatus: 'pending_approval' },
                      { $set: { isVerified: true } } // Just mark as verified, keep pending approval
                  );
                console.log(`User profile verification status updated for userId: ${userId}`);
                break;

             case 'admin_user_status_updated': // Listen for updates from Admin Service
                 console.log(`Handling admin_user_status_updated event for userId: ${userId}`);
                 const { accountStatus, reason } = payload;
                 if (accountStatus) {
                      await UserProfile.findByIdAndUpdate(userId, { accountStatus });
                      console.log(`User ${userId} account status updated to ${accountStatus} by admin.`);
                      // TODO: Optionally notify user via Notification Service about status change
                 }
                 break;

            // Handle other user event types (e.g., profile_updated, password_changed if needed)
            default:
                console.log(`Unhandled user-event type: ${type}`);
        }
    } catch (error) {
        logError(SERVICE_NAME, error, `Error handling user event type ${type} for userId ${userId}`);
    }
}

async function handleDriverUpdate(payload) {
     const { type, driverId, status, vehicleInfo /* Add other relevant fields */ } = payload;
     try {
         switch (type) {
             case 'driver_approved':
                 console.log(`Handling driver_approved event for driverId: ${driverId}`);
                 await UserProfile.findByIdAndUpdate(
                     driverId,
                     { $set: { accountStatus: 'active' } }
                 );
                 console.log(`Driver profile ${driverId} status set to active.`);
                 break;
             case 'driver_rejected':
                 console.log(`Handling driver_rejected event for driverId: ${driverId}`);
                 await UserProfile.findByIdAndUpdate(
                     driverId,
                     { $set: { accountStatus: 'rejected' } } // Use a 'rejected' status or similar
                 );
                 console.log(`Driver profile ${driverId} status set to rejected.`);
                 break;
             case 'driver_info_updated': // E.g., admin updated vehicle info
                  console.log(`Handling driver_info_updated event for driverId: ${driverId}`);
                  const updateData = {};
                  if (vehicleInfo) updateData['driverDetails.vehicleInfo'] = vehicleInfo;
                  // Add other updatable fields here
                  if (Object.keys(updateData).length > 0) {
                      await UserProfile.findByIdAndUpdate(driverId, { $set: updateData });
                      console.log(`Driver profile ${driverId} info updated.`);
                  }
                  break;
             // Handle other driver updates
             default:
                 console.log(`Unhandled driver-update type: ${type}`);
         }
     } catch (error) {
         logError(SERVICE_NAME, error, `Error handling driver update type ${type} for driverId ${driverId}`);
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
  connectKafkaConsumer,
  getKafkaConsumer,
  setupUserServiceConsumer,
  disconnectKafka,
};
