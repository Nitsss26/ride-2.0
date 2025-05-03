const { Kafka, logLevel } = require('kafkajs');
const { logError } = require('../utils/logger');

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');
const SERVICE_NAME = 'admin-service';

const kafka = new Kafka({
  clientId: SERVICE_NAME,
  brokers: KAFKA_BROKERS,
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 300,
    retries: 5
  }
});

const producer = kafka.producer();
let producerConnected = false;

async function connectKafkaProducer() {
  if (producerConnected) return true;
  try {
    await producer.connect();
    producerConnected = true;
    console.log("AdminService Kafka Producer connected successfully.");
    return true;
  } catch (error) {
    console.error('Failed to connect AdminService Kafka Producer:', error);
    logError(SERVICE_NAME, error, 'Kafka Producer Connection');
    producerConnected = false;
    return false;
  }
}

async function disconnectKafka() {
  try {
    if (producerConnected) await producer.disconnect();
    producerConnected = false;
    console.log("AdminService Kafka producer disconnected.");
  } catch (error) {
    console.error('Error disconnecting AdminService Kafka producer:', error);
    logError(SERVICE_NAME, error, 'Kafka Disconnect');
  }
}

function getKafkaProducer() {
  if (!producerConnected) {
    console.warn("Kafka Producer requested but not connected.");
    return null;
  }
  return producer;
}

// Kafka publishing helper specific to Admin Service actions
async function publishAdminActionEvent(eventType, eventData) {
    if (!producerConnected) {
        console.warn(`Kafka Producer not connected. Cannot publish admin event: ${eventType}`);
        return;
    }
    try {
        const producer = getKafkaProducer();
        let topic;
        let key;
        let basePayload = { type: eventType, timestamp: new Date().toISOString(), ...eventData };

        // Determine topic and key based on event type
        switch (eventType) {
            case 'driver_approved':
            case 'driver_rejected':
            case 'driver_info_updated':
                topic = 'driver-updates'; // Send to topic consumed by DriverService, UserService, etc.
                key = eventData.driverId;
                break;
            case 'admin_user_status_updated':
                topic = 'user-events'; // Send to topic consumed by UserService, Authservice (maybe)
                key = eventData.userId;
                break;
            // Add more cases for other admin actions like resolving disputes, etc.
            default:
                topic = 'admin-events'; // Generic topic for admin actions
                key = eventData.adminUserId || 'system'; // Key could be admin ID or related entity ID
        }

        if (!key) {
            logError(SERVICE_NAME, new Error('Missing key for Kafka event'), `Publish Admin Event ${eventType}`);
            return;
        }

        const message = {
            key: key.toString(),
            value: JSON.stringify(basePayload)
        };

        await producer.send({ topic, messages: [message] });
        console.log(`Published ${eventType} event to Kafka topic ${topic} for key ${key}`);
    } catch (error) {
        logError(SERVICE_NAME, error, `Failed to publish ${eventType} event`);
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
  connectKafkaProducer,
  getKafkaProducer,
  disconnectKafka,
  publishAdminActionEvent
};
