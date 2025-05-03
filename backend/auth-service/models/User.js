const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/\S+@\S+\.\S+/, 'Please use a valid email address.']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long'],
    select: false // Do not return password by default
  },
  role: {
    type: String,
    enum: ['rider', 'driver', 'admin'],
    required: true,
    default: 'rider'
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  verificationCode: {
    type: String,
    select: false // Do not return verification code by default
  },
  verificationCodeExpires: {
     type: Date,
     select: false // Do not return expiry by default
  },
  // Add other relevant fields like name, phone etc. if managed here
  // Or link to a separate profile in UserService using userId
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Update `updatedAt` timestamp on save/update
userSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

userSchema.pre('findOneAndUpdate', function(next) {
  this.set({ updatedAt: Date.now() });
  next();
});


// Method to compare password for login
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate verification code (example)
userSchema.methods.createVerificationCode = function() {
    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
    this.verificationCode = code;
    // Set expiration time (e.g., 10 minutes from now)
    this.verificationCodeExpires = new Date(Date.now() + 10 * 60 * 1000);
    return code;
};


module.exports = mongoose.model('User', userSchema);
