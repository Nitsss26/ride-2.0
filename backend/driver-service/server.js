require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { connectRedis, getRedisClient } = require('./redisClient');
const { connectKafkaProducer, getKafkaProducer, connectKafkaConsumer, setupDriverServiceConsumer } = require('./kafkaClient');
const Driver = require('./models/Driver');
const { getFetch } = require('./fetchHelper');
const { logError } = require('../utils/logger'); // Import logger

const app = express();
app.use(express.json());

const MONGODB_URI = process.env.DRIVER_SERVICE_MONGODB_URI || 'mongodb://localhost:27017/driver_service';
const RIDE_SERVICE_URL = process.env.RIDE_SERVICE_URL || 'http://localhost:3000';
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:3002';
const SERVICE_NAME = 'driver-service';

let isRedisConnected = false;
let isKafkaProducerConnected = false;
let isKafkaConsumerConnected = false;

// --- Database Connection ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log('DriverService MongoDB connected'))
  .catch(err => {
      logError(SERVICE_NAME, err, 'MongoDB Connection');
      console.error('DriverService MongoDB connection error:', err);
      process.exit(1); // Exit if DB fails
  });

// --- Redis Connection ---
connectRedis().then(connected => {
    isRedisConnected = connected;
    if (connected) console.log('DriverService Redis connected');
    else console.warn('DriverService Redis connection failed. Location/Status updates might fail.');
}).catch(err => logError(SERVICE_NAME, err, 'Redis Connection'));

// --- Kafka Connection ---
connectKafkaProducer().then(connected => {
    isKafkaProducerConnected = connected;
    if(connected) console.log('DriverService Kafka Producer connected');
    else console.warn('DriverService Kafka Producer connection failed. Events will not be published.');
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Producer Connection'));

connectKafkaConsumer('driver-service-group').then(connected => {
    isKafkaConsumerConnected = connected;
    if (connected) {
        console.log('DriverService Kafka Consumer connected');
        setupDriverServiceConsumer().catch(err => logError(SERVICE_NAME, err, "Kafka Consumer Setup"));
    } else {
        console.warn('DriverService Kafka Consumer connection failed. Will not process events.');
    }
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Consumer Connection'));

// --- Helper Functions ---

// Basic Haversine distance calculation (in kilometers)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the Earth in kilometers
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// --- API Endpoints ---

// Endpoint called by Ride Service (or triggered by Kafka 'ride-requested' event)
app.post('/find-drivers', async (req, res) => {
    const { ride } = req.body; // Expects the full ride object

    if (!ride || !ride._id || !ride.pickupLocation?.geo?.coordinates) {
        return res.status(400).json({ message: 'Missing ride details or pickup location coordinates' });
    }

    const rideId = ride._id.toString();
    const [pickupLon, pickupLat] = ride.pickupLocation.geo.coordinates;
    const requestedVehicleType = ride.preferences?.vehicleType; // Get requested vehicle type

    console.log(`Finding drivers for ride ${rideId} near [${pickupLon}, ${pickupLat}]` + (requestedVehicleType ? ` (Type: ${requestedVehicleType})` : ''));

    const redisClient = getRedisClient(); // Get client (might be null)
    if (!redisClient) {
         console.warn(`Redis not connected. Cannot query driver locations for ride ${rideId}.`);
         logError(SERVICE_NAME, new Error('Redis client not available'), `find-drivers ${rideId}`);
         // await publishRideUpdate(rideId, { status: 'no_drivers_found', reason: 'Location service unavailable (Redis)' });
         return res.status(503).json({ message: 'Location service unavailable (Redis)' });
    }

    try {
        // 1. Query Redis for nearby available drivers using GEORADIUS
         const searchRadiusKm = parseInt(process.env.DRIVER_SEARCH_RADIUS_KM || '5');
         const driverCountLimit = 10; // Limit initial Redis query

         let nearbyDriversResult;
         try {
              nearbyDriversResult = await redisClient.sendCommand([
                   'GEORADIUS',
                   'driver-locations', // Key from Location Service
                   String(pickupLon),
                   String(pickupLat),
                   String(searchRadiusKm),
                   'km',
                   'WITHCOORD',
                   'WITHDIST',
                   'ASC',
                   'COUNT',
                   String(driverCountLimit)
              ]);
         } catch (redisError) {
              // Handle specific Redis errors like WRONGTYPE
              if (redisError.message.includes('WRONGTYPE')) {
                  logError(SERVICE_NAME, redisError, `Redis key 'driver-locations' is not a Geo Set for ride ${rideId}`);
                  console.error(`Redis key 'driver-locations' is not a Geo Set. Ensure Location Service is writing correctly.`);
                  await publishRideUpdate(rideId, { status: 'no_drivers_found', reason: 'Internal location data error.' });
                  return res.status(500).json({ message: 'Internal location data error.' });
              }
              // Rethrow other Redis errors
              throw redisError;
         }


         console.log(`Redis GEORADIUS result for ride ${rideId}:`, nearbyDriversResult);

        if (!nearbyDriversResult || nearbyDriversResult.length === 0) {
            console.log(`No drivers found within ${searchRadiusKm}km for ride ${rideId}`);
            await publishRideUpdate(rideId, { status: 'no_drivers_found', reason: 'No drivers in range' });
            return res.status(404).json({ message: 'No available drivers found nearby' });
        }

        // 2. Filter results to get only driver IDs and distances
         const nearbyDriverIdsWithDistance = nearbyDriversResult.map(result => ({
           driverId: result[0], // Driver ID is the member name
           distance: parseFloat(result[1]), // Distance is the second element
           coordinates: result[2] // [lon, lat]
          }));

        // 3. Fetch driver details (rating, vehicle, status) from MongoDB for the nearby IDs
        const driverIds = nearbyDriverIdsWithDistance.map(d => d.driverId);
        const driversFromDb = await Driver.find({
            _id: { $in: driverIds },
            isOnline: true,
            currentStatus: 'available' // Ensure they are actually available in DB too
        }).select('rating vehicle currentStatus'); // Select necessary fields

        // 4. Combine Redis location data with DB data and filter unavailable/mismatched drivers
        let availableDrivers = nearbyDriverIdsWithDistance
            .map(redisDriver => {
                const dbDriver = driversFromDb.find(db => db._id.toString() === redisDriver.driverId);
                if (dbDriver) {
                    // Vehicle Type Filter
                    if (requestedVehicleType && requestedVehicleType !== 'Any' && dbDriver.vehicle?.type !== requestedVehicleType) {
                         console.log(`Driver ${redisDriver.driverId} skipped for ride ${rideId}: Vehicle type mismatch (Required: ${requestedVehicleType}, Has: ${dbDriver.vehicle?.type})`);
                         return null; // Skip driver if vehicle type doesn't match
                    }
                    return {
                        driverId: redisDriver.driverId,
                        distance: redisDriver.distance,
                        rating: dbDriver.rating,
                        vehicle: dbDriver.vehicle, // Include vehicle info
                        status: dbDriver.currentStatus // Should be 'available'
                   };
                }
               return null; // Driver found in Redis but not available in DB (or DB error)
            })
            .filter(driver => driver !== null); // Remove null entries


        if (availableDrivers.length === 0) {
            console.log(`No *available* drivers found for ride ${rideId} after DB check/filtering.`);
             await publishRideUpdate(rideId, { status: 'no_drivers_found', reason: 'Nearby drivers not available or vehicle type mismatch' });
            return res.status(404).json({ message: 'No suitable available drivers found nearby' });
        }

        // 5. Implement Matching Algorithm (Simple example: sort by distance, then rating)
        availableDrivers.sort((a, b) => {
            if (a.distance !== b.distance) {
                return a.distance - b.distance; // Closer drivers first
            }
            return b.rating - a.rating; // Higher rating second
        });

        // 6. Create Driver Batch (e.g., top 3-5 drivers)
        const batchSize = parseInt(process.env.DRIVER_BATCH_SIZE || '3');
        const driverBatch = availableDrivers.slice(0, batchSize);

        console.log(`Created batch of ${driverBatch.length} drivers for ride ${rideId}:`, driverBatch.map(d=>d.driverId));

        // 7. Store Batch in Redis with TTL
        const batchKey = `driver-batch:${rideId}`;
        const batchTTL = parseInt(process.env.DRIVER_BATCH_TTL_SECONDS || '60'); // Use configured TTL
        try {
            // Pass the original ride object along with the batch for context in Notification Service
             await redisClient.set(batchKey, JSON.stringify({ drivers: driverBatch, rideDetails: ride }), { EX: batchTTL });
             console.log(`Stored driver batch in Redis for ride ${rideId} with TTL ${batchTTL}s`);
        } catch (redisError) {
             logError(SERVICE_NAME, redisError, `Redis Set Batch Failed for ride ${rideId}`);
             // If setting batch fails, we probably can't proceed reliably
             return res.status(500).json({ message: 'Failed to store driver batch' });
        }


        // 8. Publish driver-match event to Kafka (for Notification Service)
        const producer = getKafkaProducer();
        if (producer) {
            try {
                await producer.send({
                    topic: 'driver-matches',
                    // Send the full ride details along with the batch
                    messages: [{ key: rideId, value: JSON.stringify({ rideId: rideId, batch: driverBatch, rideDetails: ride }) }],
                });
                console.log(`Published driver-match event for ride ${rideId}`);
            } catch (kafkaError) {
                 logError(SERVICE_NAME, kafkaError, `Kafka Publish driver-match Failed for ${rideId}`);
                 console.error(`Kafka Producer error. Cannot publish driver-match event for ${rideId}.`);
                 // Should we attempt fallback notification call? Maybe not, as Kafka is critical path.
                 return res.status(500).json({ message: 'Failed to notify matching service' });
            }
        } else {
            console.warn(`Kafka Producer not connected. Cannot publish driver-match event for ${rideId}.`);
            // Fallback simulation (remove for production)
             try {
                 const fetch = await getFetch();
                 await fetch(`${NOTIFICATION_SERVICE_URL}/notify/drivers`, { // Endpoint expects batch
                     method: 'POST',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify({ rideId: rideId, batch: driverBatch, rideDetails: ride }),
                 });
                 console.log(`Simulated call to Notification Service for ride ${rideId}`);
             } catch (fetchError) {
                 logError(SERVICE_NAME, fetchError, `Simulated Notification Service call failed for ride ${rideId}`);
             }
        }

        res.status(200).json({ message: 'Driver search initiated', batch: driverBatch });

    } catch (error) {
        logError(SERVICE_NAME, error, `POST /find-drivers for ride ${rideId}`);
        console.error(`Error finding drivers for ride ${rideId}:`, error);
        // Avoid publishing update again if already done
        if (res.statusCode < 500) { // Only publish if not already handled (e.g., Redis error)
            publishRideUpdate(rideId, { status: 'no_drivers_found', reason: 'Internal search error' }).catch(e => logError(SERVICE_NAME, e, 'Publish Ride Update on Find Error'));
        }
        res.status(500).json({ message: 'Failed to find drivers' });
    }
});


// Endpoint to update driver status (called internally or via Kafka)
app.put('/drivers/:driverId/status', async (req, res) => {
    const { driverId } = req.params;
    const { status, rideId } = req.body; // e.g., 'available', 'busy', 'offline'

    if (!status) {
        return res.status(400).json({ message: 'Missing status' });
    }
    const validStatuses = ['available', 'busy', 'offline', 'en_route_pickup', 'at_pickup', 'on_ride', 'driver_arrived']; // Added driver_arrived
     if (!validStatuses.includes(status)) {
         return res.status(400).json({ message: `Invalid status provided: ${status}` });
     }

    console.log(`Updating status for driver ${driverId} to ${status}` + (rideId ? ` for ride ${rideId}` : ''));

    try {
        const driver = await Driver.findById(driverId);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }

        // Update status in MongoDB
        driver.currentStatus = status;
        driver.isOnline = status !== 'offline'; // Update online status based on main status
        // Assign rideId ONLY if transitioning to a busy state for that ride
        const busyStates = ['busy', 'en_route_pickup', 'at_pickup', 'on_ride', 'driver_arrived'];
        if (busyStates.includes(status) && rideId) {
            driver.currentRideId = rideId;
        } else if (status === 'available' || status === 'offline') {
            // Clear rideId only if the update is NOT related to a specific ride OR if the ride matches the one being cleared
            if (!rideId || (rideId && driver.currentRideId === rideId)) {
                 driver.currentRideId = null;
            }
        }
        await driver.save();

        // Update status and location in Redis
        const redisClient = getRedisClient();
        if (redisClient) {
             try {
                 const statusKey = `driver-status:${driverId}`;
                 await redisClient.set(statusKey, status); // Store simple status string

                 // Update Geo Set based on online status
                 if (status === 'offline') {
                     await redisClient.zRem('driver-locations', driverId);
                     console.log(`Removed offline driver ${driverId} from Redis Geo Set.`);
                 } else if (driver.isOnline && driver.lastKnownLocation?.coordinates) {
                     const [lon, lat] = driver.lastKnownLocation.coordinates;
                     await redisClient.geoAdd('driver-locations', { longitude: lon, latitude: lat, member: driverId });
                    // console.log(`Updated online driver ${driverId} in Redis Geo Set.`); // Can be noisy
                 }
                 console.log(`Driver ${driverId} status updated to ${status} in Redis`);
             } catch (redisError) {
                  logError(SERVICE_NAME, redisError, `Redis Update Status/Location Failed for ${driverId}`);
                  console.warn(`Redis not connected or SET/GEOADD failed. Cannot update status/location for driver ${driverId} in Redis.`);
             }
        } else {
            console.warn(`Redis not connected. Cannot update status/location for driver ${driverId} in Redis.`);
        }

        // Publish driver status update event (optional, if other services need to react)
        // publishDriverEvent(driverId, 'status_updated', { newStatus: status, rideId: driver.currentRideId });

        res.status(200).json({ message: 'Driver status updated successfully', driver });

    } catch (error) {
        logError(SERVICE_NAME, error, `PUT /drivers/${driverId}/status`);
        res.status(500).json({ message: 'Failed to update driver status' });
    }
});

// Get Driver Details
app.get('/drivers/:driverId', async (req, res) => {
    try {
        const driver = await Driver.findById(req.params.driverId);
        if (!driver) {
            return res.status(404).json({ message: 'Driver not found' });
        }
        res.json(driver);
    } catch (error) {
        logError(SERVICE_NAME, error, `GET /drivers/${req.params.driverId}`);
        res.status(500).json({ message: 'Failed to get driver details' });
    }
});

// Add a new driver (for testing/setup)
app.post('/drivers', async (req, res) => {
    try {
        const newDriver = new Driver(req.body);
        await newDriver.save();
        res.status(201).json(newDriver);
    } catch (error) {
        logError(SERVICE_NAME, error, 'POST /drivers');
        if (error.code === 11000) { // Duplicate key
             return res.status(409).json({ message: "Failed to create driver: Duplicate key (email, phone, or licensePlate).", error: error.message });
        }
        res.status(400).json({ message: "Failed to create driver", error: error.message });
    }
});


// --- Kafka Publishing Helper ---
async function publishRideUpdate(rideId, updateData) {
    const producer = getKafkaProducer();
    if (!producer) {
        console.warn(`Kafka Producer not connected. Cannot publish ride update for ${rideId}. Simulating Ride Service call.`);
        // Fallback simulation (remove for production)
        try {
             const fetch = await getFetch();
             await fetch(`${RIDE_SERVICE_URL}/rides/${rideId}/status`, {
                 method: 'PUT',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify(updateData),
             });
             console.log(`Simulated call to Ride Service for ride ${rideId} status update:`, updateData);
         } catch (fetchError) {
             logError(SERVICE_NAME, fetchError, `Simulated Ride Service call failed for ride ${rideId} status update`);
         }
        return;
    }
    try {
        await producer.send({
            topic: 'ride-updates', // Topic for Ride Service to consume status updates
            messages: [{ key: rideId, value: JSON.stringify({ rideId, ...updateData, timestamp: new Date().toISOString() }) }], // Add timestamp
        })
        console.log(`Published ride update event for ride ${rideId}:`, updateData);
    } catch (error) {
        logError(SERVICE_NAME, error, `Kafka Publish ride-updates Failed for ${rideId}`);
        console.error(`Failed to publish ride update for ride ${rideId}:`, error);
    }
}


// --- Health Check ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        mongo: mongoose.connection.readyState === 1,
        redis: isRedisConnected,
        kafkaProducer: isKafkaProducerConnected,
        kafkaConsumer: isKafkaConsumerConnected
     })
})

// --- Server Start ---
const PORT = process.env.DRIVER_SERVICE_PORT || 3001;
app.listen(PORT, () => {
    console.log(`Driver Service listening on port ${PORT}`);
})

// Basic Error Handling Middleware
app.use((err, req, res, next) => {
  logError(SERVICE_NAME, err, 'Unhandled Route Error');
  console.error(err.stack);
  res.status(500).send('Something broke!');
});
