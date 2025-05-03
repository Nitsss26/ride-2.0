const jwt = require('jsonwebtoken');
const AdminUser = require('../models/AdminUser');
const { logError } = require('../../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'YourSuperSecretKeyForJWT';
const SERVICE_NAME = 'admin-service';

const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      // Get token from header
      token = req.headers.authorization.split(' ')[1];

      // Verify token
      const decoded = jwt.verify(token, JWT_SECRET);

      // Check token role - ensure it's an admin role
       if (!decoded.role || !['admin', 'superadmin', 'support_lead', 'operations'].includes(decoded.role)) {
           logError(SERVICE_NAME, `Invalid token role attempt: ${decoded.role}`, 'Auth Middleware');
           return res.status(403).json({ message: 'Not authorized, invalid token role' });
       }

      // Get admin user from the database using the ID from the token
      // Select only necessary fields, explicitly exclude password even if schema doesn't
      req.adminUser = await AdminUser.findById(decoded.userId).select('-password');

      if (!req.adminUser) {
        logError(SERVICE_NAME, `Admin user not found for token ID: ${decoded.userId}`, 'Auth Middleware');
        return res.status(401).json({ message: 'Not authorized, user not found' });
      }
       if (!req.adminUser.isActive) {
           logError(SERVICE_NAME, `Inactive admin user login attempt: ${decoded.userId}`, 'Auth Middleware');
           return res.status(403).json({ message: 'Not authorized, account inactive' });
       }

      next(); // Proceed to the next middleware or route handler
    } catch (error) {
      logError(SERVICE_NAME, error, 'Auth Middleware Token Verification');
      res.status(401).json({ message: 'Not authorized, token failed' });
    }
  }

  if (!token) {
    res.status(401).json({ message: 'Not authorized, no token' });
  }
};

// Optional: Middleware to check for specific admin roles
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.adminUser || !roles.includes(req.adminUser.role)) {
      logError(SERVICE_NAME, `Role authorization failed. Required: ${roles.join('/')}, User Role: ${req.adminUser?.role}`, 'Authorize Middleware');
      return res.status(403).json({ message: `User role ${req.adminUser?.role} is not authorized to access this route` });
    }
    next();
  };
};


module.exports = { protect, authorize };
