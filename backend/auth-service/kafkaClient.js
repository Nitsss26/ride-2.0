const { Kafka, logLevel } = require('kafkajs');

const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'localhost:9092').split(',');

const kafka = new Kafka({
  clientId: 'auth-service',
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
    console.log("AuthService Kafka Producer connected successfully.");
    return true;
  } catch (error) {
    console.error('Failed to connect AuthService Kafka Producer:', error);
    producerConnected = false;
    return false;
  }
}

async function disconnectKafka() {
  try {
    if (producerConnected) await producer.disconnect();
    producerConnected = false;
    console.log("AuthService Kafka producer disconnected.");
  } catch (error) {
    console.error('Error disconnecting AuthService Kafka producer:', error);
  }
}

function getKafkaProducer() {
  if (!producerConnected) {
    console.warn("Kafka Producer requested but not connected.");
    return null;
  }
  return producer;
}

// Kafka publishing helper specific to Auth Service
async function publishUserEvent(eventType, userData) {
    if (!producerConnected) {
        console.warn(`Kafka Producer not connected. Cannot publish user event: ${eventType}`);
        return;
    }
    try {
        const producer = getKafkaProducer();
        const topic = 'user-events'; // Central topic for user-related events
        const message = {
            key: userData._id.toString(), // Use user ID as key
            value: JSON.stringify({
                type: eventType, // e.g., 'user_created', 'user_verified'
                userId: userData._id,
                email: userData.email,
                role: userData.role,
                timestamp: new Date().toISOString()
                // Add other relevant data as needed
            })
        };
        await producer.send({ topic, messages: [message] });
        console.log(`Published ${eventType} event to Kafka topic ${topic} for user ${userData._id}`);
    } catch (error) {
        console.error(`Failed to publish ${eventType} event for user ${userData._id}:`, error);
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
  publishUserEvent
};
