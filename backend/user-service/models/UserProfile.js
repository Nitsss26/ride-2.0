const mongoose = require('mongoose');

const userProfileSchema = new mongoose.Schema({
  _id: { // Explicitly use the same ID as the Auth Service User
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    alias: 'userId' // Alias for easier reference
  },
  email: { // Store email for reference, managed by Auth Service
    type: String,
    required: true,
    unique: true,
    lowercase: true,
  },
  role: { // Store role for reference, managed by Auth Service
    type: String,
    enum: ['rider', 'driver', 'admin'],
    required: true,
  },
  name: {
    type: String,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
    // Add validation if needed
  },
  profilePictureUrl: {
    type: String,
    default: null, // URL to profile picture
  },
  address: { // Optional: User's home address etc.
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: String,
  },
  paymentMethods: [ // Simplified list of payment method references (IDs or basic info)
    {
        type: { type: String, enum: ['card', 'wallet'] }, // 'card', 'paypal', 'wallet' etc.
        last4: String, // e.g., last 4 digits of card
        brand: String, // e.g., 'Visa'
        isDefault: Boolean,
        // Avoid storing full payment details here; link to Payment Service if needed
    }
  ],
  // Rider specific fields
  savedLocations: [
    {
      name: String, // e.g., 'Home', 'Work'
      address: String,
      geo: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: [Number] // [longitude, latitude]
      }
    }
  ],
  // Driver specific fields (might be better in Driver Service, but mirroring here for simplicity)
  driverDetails: {
    licenseNumber: String,
    insurancePolicy: String,
    vehicleInfo: { // Basic vehicle info reference
        licensePlate: String,
        make: String,
        model: String,
        color: String
    }
    // Document URLs/references might be stored here or in Admin Service
  },
  // Common fields
  isVerified: { // Mirrored from Auth Service, updated via Kafka
      type: Boolean,
      default: false
  },
  accountStatus: {
      type: String,
      enum: ['active', 'suspended', 'banned', 'pending_verification', 'pending_approval'], // Added pending states
      default: 'pending_verification'
  },
  ratings: { // Average ratings given BY this user (if applicable)
      average: Number,
      count: Number
  },
  preferences: {
      communication: {
          email: { type: Boolean, default: true },
          sms: { type: Boolean, default: false },
          push: { type: Boolean, default: true }
      },
      // other preferences
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false }); // Use the provided _id

// Index for faster lookups by email (though primary key is _id)
userProfileSchema.index({ email: 1 });
userProfileSchema.index({ 'driverDetails.vehicleInfo.licensePlate': 1 }, { sparse: true }); // If searching drivers by plate

// Update `updatedAt` timestamp on save/update
userProfileSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

userProfileSchema.pre('findOneAndUpdate', function(next) {
  this.set({ updatedAt: Date.now() });
  next();
});


module.exports = mongoose.model('UserProfile', userProfileSchema);
