const mongoose = require('mongoose');

// Schema to store aggregated or individual ride metrics for analysis
const rideMetricSchema = new mongoose.Schema({
  rideId: {
    type: String, // Use String to match Ride Service ID format
    // type: mongoose.Schema.Types.ObjectId,
    required: true,
    unique: true, // Each ride should have only one metric entry
    index: true
  },
  riderId: {
    type: String,
    required: true,
    index: true
  },
  driverId: {
    type: String,
    required: true,
    index: true
  },
  requestedAt: {
    type: Date,
    required: true
  },
  assignedAt: {
    type: Date,
    index: true
  },
  driverArrivedAt: {
    type: Date
  },
  startedAt: { // When ride actually begins (OTP verified)
    type: Date,
    index: true
  },
  completedAt: {
    type: Date,
    index: true
  },
  cancelledAt: {
    type: Date
  },
  timedOutAt: {
      type: Date
  },
  pickupWaitTimeSeconds: { // Time from request to assignment
    type: Number
  },
  driverArrivalTimeSeconds: { // Time from assignment to driver arrival
      type: Number
  },
  rideDurationSeconds: { // Time from start to completion
    type: Number
  },
  distanceKm: { // Store calculated distance if available
    type: Number
  },
  fareAmount: {
    type: Number
  },
  fareCurrency: {
    type: String
  },
  driverRatingGiven: { // Rating rider gave driver
    type: Number
  },
  riderRatingGiven: { // Rating driver gave rider (if implemented)
      type: Number
  },
  pickupLocation: { // Store for geo-analysis
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: [Number] // [longitude, latitude]
  },
  dropoffLocation: { // Store for geo-analysis
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: [Number] // [longitude, latitude]
  },
  finalStatus: { // Final status of the ride
      type: String,
      required: true,
      index: true
  },
  processedAt: { // When this metric record was created/updated
    type: Date,
    default: Date.now
  }
});

// Index for time-based analysis
rideMetricSchema.index({ completedAt: 1 });
rideMetricSchema.index({ requestedAt: 1 });

// Optional: Geospatial index for analyzing rides by location
// rideMetricSchema.index({ pickupLocation: '2dsphere' });
// rideMetricSchema.index({ dropoffLocation: '2dsphere' });

module.exports = mongoose.model('RideMetric', rideMetricSchema);
