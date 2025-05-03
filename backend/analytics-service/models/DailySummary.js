const mongoose = require('mongoose');

// Schema for storing daily aggregated analytics
const dailySummarySchema = new mongoose.Schema({
  date: { // The date for which the summary applies (YYYY-MM-DD format or Date object at midnight)
    type: Date,
    required: true,
    unique: true,
    index: true
  },
  totalRidesRequested: {
    type: Number,
    default: 0
  },
  totalRidesCompleted: {
    type: Number,
    default: 0
  },
  totalRidesCancelledRider: {
      type: Number,
      default: 0
  },
  totalRidesCancelledDriver: {
      type: Number,
      default: 0
  },
  totalRidesTimedOut: {
      type: Number,
      default: 0
  },
  totalEarnings: { // Sum of fares for completed rides
    type: Number,
    default: 0
  },
  currency: { // Assuming a single currency for simplicity, adjust if needed
      type: String,
      default: 'USD'
  },
  averagePickupWaitTimeSeconds: { // Average time from request to assignment
    type: Number,
    default: 0
  },
  averageDriverArrivalTimeSeconds: { // Average time from assignment to arrival
      type: Number,
      default: 0
  },
  averageRideDurationSeconds: {
    type: Number,
    default: 0
  },
  averageDriverRating: { // Average rating given to drivers for rides completed today
      type: Number,
      default: 0
  },
  totalDriversOnline: { // Peak or average drivers online during the day
      type: Number,
      default: 0
  },
  peakDemandHours: [ // Array of hours (0-23) with highest request volume
      { type: Number }
  ],
  surgePeriods: [ // Information about surge pricing activation
      {
          startTime: Date,
          endTime: Date,
          multiplier: Number,
          area: String // Identifier for the surge area (e.g., "Downtown")
      }
  ],
  // Add more metrics as needed
  lastUpdatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update `lastUpdatedAt` timestamp on save/update
dailySummarySchema.pre('save', function(next) {
  this.lastUpdatedAt = Date.now();
  next();
});

dailySummarySchema.pre('findOneAndUpdate', function(next) {
  this.set({ lastUpdatedAt: Date.now() });
  next();
});

module.exports = mongoose.model('DailySummary', dailySummarySchema);
