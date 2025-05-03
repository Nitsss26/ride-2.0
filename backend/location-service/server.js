require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const { connectRedis, getRedisClient, getRedisPublisher } = require('./redisClient'); // Use publisher for pub/sub
const LocationUpdate = require('./models/LocationUpdate'); // Model for batch saving
const DriverSchema = require('./models/Driver').schema; // Import ONLY the schema definition
const { logError } = require('../utils/logger'); // Import logger

const app = express();
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MONGODB_URI = process.env.LOCATION_SERVICE_MONGODB_URI || 'mongodb://localhost:27017/location_service';
const DRIVER_SERVICE_MONGODB_URI = process.env.DRIVER_SERVICE_MONGODB_URI_FOR_LOCATION || process.env.DRIVER_SERVICE_MONGODB_URI || 'mongodb://localhost:27017/driver_service'; // For updating Driver model

const SERVICE_NAME = 'location-service';
let isRedisConnected = false;
let locationUpdateBuffer = []; // Buffer for batch DB writes
const BATCH_INTERVAL = parseInt(process.env.LOCATION_BATCH_INTERVAL_MS || '60000'); // Default 1 minute
const BATCH_SIZE = parseInt(process.env.LOCATION_BATCH_SIZE || '50'); // Default 50 updates per batch

let locationDbConnection;
let driverServiceDbConnection;
let DriverModel; // To store the compiled Driver model

// --- Database Connections ---
async function connectDatabases() {
    try {
        // Primary DB for Location Service (storing historical updates)
        locationDbConnection = await mongoose.createConnection(MONGODB_URI).asPromise();
        console.log('LocationService Primary MongoDB connected (for LocationUpdate)');
        // Compile LocationUpdate model using this connection
        locationDbConnection.model('LocationUpdate', LocationUpdate.schema);

        // Secondary connection to Driver Service DB (for updating Driver.lastKnownLocation)
        driverServiceDbConnection = await mongoose.createConnection(DRIVER_SERVICE_MONGODB_URI).asPromise();
        console.log('LocationService connected to DriverService MongoDB (for Driver updates)');
        // Compile the Driver model using the specific connection and imported schema
        DriverModel = driverServiceDbConnection.model('Driver', DriverSchema); // Use existing schema

    } catch (err) {
        logError(SERVICE_NAME, err, 'MongoDB Connections');
        console.error('LocationService MongoDB connection error(s):', err);
        // Decide if the service can run without one or both DBs
        // process.exit(1); // Exit if critical DB connection fails
    }
}
connectDatabases();


// --- Redis Connection ---
connectRedis().then(connected => {
    isRedisConnected = connected;
    if (connected) console.log('LocationService Redis connected (Client & Publisher)');
    else console.warn('LocationService Redis connection failed. Real-time updates will fail.');
}).catch(err => logError(SERVICE_NAME, err, 'Redis Connection'));

// --- WebSocket Handling (Driver Location Updates) ---
wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const driverId = urlParams.get('driverId');

    if (!driverId) {
         console.log('Driver WebSocket connection attempt without driverId. Closing.');
         ws.close(1008, "Driver ID is required");
         return;
     }
     // Validate driverId format if necessary (e.g., check if it's a valid ObjectId)
     if (!mongoose.Types.ObjectId.isValid(driverId)) {
         console.log(`Invalid driverId format received: ${driverId}. Closing connection.`);
         ws.close(1008, "Invalid Driver ID format");
         return;
     }

     console.log(`Driver WebSocket client connected: ${driverId}`);

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (error) {
             logError(SERVICE_NAME, error, `WS JSON Parse Error from ${driverId}`);
             console.error(`Failed to parse WebSocket message from driver ${driverId}:`, message.toString());
             ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON format' }));
             return;
        }

        try {
            if (data.type === 'location_update' && data.location) {
                const { latitude, longitude } = data.location;
                 const rideId = data.rideId; // Include rideId if driver is on a ride

                if (typeof latitude !== 'number' || typeof longitude !== 'number') {
                     console.warn(`Received invalid location data types from driver ${driverId}: lat=${latitude}, lon=${longitude}`);
                     ws.send(JSON.stringify({ type: 'error', message: 'Invalid location data types' }));
                     return;
                 }

                // console.log(`Received location update from driver ${driverId}: Lat=${latitude}, Lon=${longitude}` + (rideId ? ` Ride=${rideId}` : '')); // Too noisy

                const redisClient = getRedisClient();
                const redisPublisher = getRedisPublisher();
                if (!redisClient || !redisPublisher) { // Check if clients are available
                    console.warn(`Redis not connected. Cannot process location update for driver ${driverId}.`);
                    // Optionally buffer here if Redis is down, but risk memory issues
                    return;
                }

                const timestamp = new Date();

                // 1. Immediately update Redis Geo Set (for Driver Service matching)
                try {
                     await redisClient.geoAdd('driver-locations', {
                         longitude: longitude,
                         latitude: latitude,
                         member: driverId // Use the validated driverId
                     });
                } catch (geoError) {
                     logError(SERVICE_NAME, geoError, `Redis GEOADD Failed for driver ${driverId}`);
                     console.error(`Error updating Redis Geo Set for driver ${driverId}:`, geoError);
                     // Continue processing other updates if possible
                }


                 // 2. Publish location update to Redis Pub/Sub channel (for Rider App via Notification Service)
                 const pubSubChannel = `driver-location-updates:${driverId}`;
                 const pubSubPayload = JSON.stringify({
                     driverId: driverId,
                     rideId: rideId, // Pass rideId along
                     location: {
                         latitude: latitude,
                         longitude: longitude,
                         timestamp: timestamp.toISOString()
                     }
                 });
                 try {
                    await redisPublisher.publish(pubSubChannel, pubSubPayload);
                 } catch (pubError) {
                    logError(SERVICE_NAME, pubError, `Redis Publish Failed for channel ${pubSubChannel}`);
                    console.error(`Error publishing location update to Redis channel ${pubSubChannel}:`, pubError);
                 }


                // 3. Add to buffer for batch DB write (LocationUpdate collection)
                // Ensure driverId is valid ObjectId before buffering if schema requires it
                 locationUpdateBuffer.push({
                     driverId: driverId, // Already validated
                     rideId: rideId, // Should also be validated if storing as ObjectId
                     location: {
                         type: 'Point',
                         coordinates: [longitude, latitude]
                     },
                     timestamp: timestamp
                 });

                 // 4. Update Driver model's lastKnownLocation (direct DB update - less frequent might be better)
                  if (DriverModel) { // Check if DriverModel was successfully compiled
                     try {
                         await DriverModel.findByIdAndUpdate(driverId, {
                              $set: {
                                   'lastKnownLocation': {
                                        type: 'Point',
                                        coordinates: [longitude, latitude],
                                        timestamp: timestamp
                                    }
                                }
                            }, { timestamps: false }); // Avoid triggering default timestamps here
                     } catch (dbError) {
                           logError(SERVICE_NAME, dbError, `Driver DB Update lastKnownLocation Failed for ${driverId}`);
                           console.error(`Error updating lastKnownLocation in Driver DB for ${driverId}:`, dbError);
                      }
                  } else {
                       console.warn(`DriverService DB connection/model not available. Cannot update Driver.lastKnownLocation for ${driverId}`);
                  }


                // Optional: Send ack back to driver
                ws.send(JSON.stringify({ type: 'location_ack', timestamp: timestamp.toISOString() }));

            } else if (data.type === 'ping') {
                 ws.send(JSON.stringify({ type: 'pong' }));
             }
            else {
                console.log(`Unknown message type from driver ${driverId}: ${data.type}`);
                 ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${data.type}` }));
            }
        } catch (error) {
             logError(SERVICE_NAME, error, `WS Message Handle Error from ${driverId}`);
             console.error(`Failed to handle WebSocket message from driver ${driverId}:`, error);
             ws.send(JSON.stringify({ type: 'error', message: 'Internal server error handling message' }));
        }
    });

    ws.on('close', () => {
        console.log(`Driver WebSocket client disconnected: ${driverId}`);
    });

    ws.on('error', (error) => {
         logError(SERVICE_NAME, error, `WebSocket Error for ${driverId}`);
         console.error(`WebSocket error for driver ${driverId}:`, error);
    });
});

// --- Batch Database Writing ---
async function writeLocationBufferToDb() {
    if (locationUpdateBuffer.length === 0) {
        return; // Nothing to write
    }

    // Ensure Location DB connection and model are available
    const LocationUpdateModel = locationDbConnection?.model('LocationUpdate');
    if (!LocationUpdateModel) {
        console.error("LocationUpdate model not available. Cannot write buffer.");
        // Consider how to handle buffer - retry later? Log failures?
        locationUpdateBuffer = []; // Clear buffer to prevent memory leak for now
        return;
    }

    const batchToWrite = [...locationUpdateBuffer]; // Copy buffer
    locationUpdateBuffer = []; // Clear original buffer immediately

    // console.log(`Attempting to write ${batchToWrite.length} location updates to DB.`); // Can be noisy

    try {
        await LocationUpdateModel.insertMany(batchToWrite, { ordered: false }); // ordered: false allows partial success
        // console.log(`Successfully wrote ${batchToWrite.length} location updates to DB.`); // Can be noisy
    } catch (error) {
        logError(SERVICE_NAME, error, `LocationUpdate Batch Insert Failed (${batchToWrite.length} items)`);
        console.error('Error writing location batch to DB:', error);
        // Decide on error handling: retry failed inserts, log them, or discard?
        // For now, we log the error and discard the failed batch.
    }
}

// Start the batch writing interval
setInterval(writeLocationBufferToDb, BATCH_INTERVAL);

// Also write if buffer gets large
setInterval(() => {
     if (locationUpdateBuffer.length >= BATCH_SIZE) {
         console.log(`Buffer size limit (${BATCH_SIZE}) reached. Writing batch early.`);
         writeLocationBufferToDb();
     }
 }, 5000); // Check buffer size every 5 seconds


// --- Health Check ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        mongoPrimary: locationDbConnection?.readyState === 1,
        mongoDriverService: driverServiceDbConnection?.readyState === 1,
        redis: isRedisConnected,
        activeWebSockets: wss.clients.size,
        locationBuffer: locationUpdateBuffer.length
    });
});

// --- Server Start ---
const PORT = process.env.LOCATION_SERVICE_PORT || 3003;
server.listen(PORT, () => {
    console.log(`Location Service (including WebSocket Server) listening on port ${PORT}`);
});

// Basic Error Handling Middleware
app.use((err, req, res, next) => {
  logError(SERVICE_NAME, err, 'Unhandled Route Error');
  console.error(err.stack);
  res.status(500).send('Something broke!');
});
