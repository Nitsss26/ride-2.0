const mongoose = require('mongoose');

const driverDocumentSchema = new mongoose.Schema({
  driverId: {
    type: String, // Link to the Driver ID (from Driver Service / User Service)
    // type: mongoose.Schema.Types.ObjectId,
    // ref: 'Driver', // or 'UserProfile'
    required: true,
    index: true
  },
  documentType: {
    type: String,
    enum: ['license', 'insurance', 'vehicle_registration', 'profile_photo', 'other'],
    required: true
  },
  documentUrl: { // URL where the document is stored (e.g., S3, Firebase Storage)
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending_review', 'approved', 'rejected', 'expired'],
    default: 'pending_review',
    index: true
  },
  rejectionReason: { // Reason if the document was rejected
    type: String,
    trim: true
  },
  expiryDate: { // Optional: Expiry date for documents like license or insurance
    type: Date,
    index: true
  },
  uploadedAt: {
    type: Date,
    default: Date.now
  },
  reviewedBy: { // Optional: ID of the admin who reviewed the document
     type: String,
    // type: mongoose.Schema.Types.ObjectId,
    // ref: 'AdminUser'
    default: null
  },
  reviewedAt: {
    type: Date,
    default: null
  }
});

// Update timestamps (though only reviewedAt might be manually set)
driverDocumentSchema.pre('save', function(next) {
    if (this.isModified('status') && this.status !== 'pending_review' && !this.reviewedAt) {
        this.reviewedAt = Date.now();
    }
    next();
});

driverDocumentSchema.pre('findOneAndUpdate', function(next) {
    const update = this.getUpdate();
    if (update.$set && update.$set.status && update.$set.status !== 'pending_review') {
        this.set({ reviewedAt: new Date() });
    }
    next();
});

// Compound index for finding documents for a driver
driverDocumentSchema.index({ driverId: 1, documentType: 1 });
// Index for finding pending documents
driverDocumentSchema.index({ status: 1, uploadedAt: 1 });

module.exports = mongoose.model('DriverDocument', driverDocumentSchema);
