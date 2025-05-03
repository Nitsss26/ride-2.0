const mongoose = require('mongoose');

const supportTicketSchema = new mongoose.Schema({
  userId: { // ID of the user reporting the issue (rider or driver)
    type: String, // Use string if coming from JWT or different services
    // type: mongoose.Schema.Types.ObjectId,
    // ref: 'UserProfile', // Link to UserProfile model conceptually
    required: true,
    index: true
  },
  userRole: {
      type: String,
      enum: ['rider', 'driver'],
      required: true
  },
  rideId: { // Optional: ID of the related ride
    type: String,
    // type: mongoose.Schema.Types.ObjectId,
    // ref: 'Ride', // Link to Ride model conceptually
    index: true,
    sparse: true
  },
  issueType: {
    type: String,
    enum: [ // Example issue types
        'payment_dispute',
        'rating_dispute',
        'lost_item',
        'driver_behavior',
        'rider_behavior',
        'vehicle_issue',
        'app_bug',
        'safety_concern',
        'account_issue',
        'emergency',
        'other'
        ],
    required: true
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  status: {
    type: String,
    enum: ['open', 'in_progress', 'resolved', 'closed', 'escalated'],
    default: 'open',
    index: true
  },
  severity: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium'
  },
  assignedTo: { // Optional: ID of the support agent
    type: String,
    // type: mongoose.Schema.Types.ObjectId,
    // ref: 'AdminUser' // Link to AdminUser model conceptually
    default: null
  },
  resolutionNotes: { // Notes added by support staff upon resolution
    type: String,
    trim: true
  },
  attachments: [ // Optional: URLs to attached images/files
    { type: String }
  ],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  resolvedAt: {
      type: Date,
      default: null
  }
});

// Update `updatedAt` timestamp on save/update
supportTicketSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  if (this.isModified('status') && ['resolved', 'closed'].includes(this.status) && !this.resolvedAt) {
      this.resolvedAt = Date.now();
  }
  next();
});

supportTicketSchema.pre('findOneAndUpdate', function(next) {
  this.set({ updatedAt: Date.now() });
  // If status is updated to resolved/closed, set resolvedAt if not already set
  const update = this.getUpdate();
  if (update.$set && ['resolved', 'closed'].includes(update.$set.status)) {
       this.set({ resolvedAt: new Date() });
   }
  next();
});

// Index for common queries
supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ severity: 1, status: 1 });

module.exports = mongoose.model('SupportTicket', supportTicketSchema);
