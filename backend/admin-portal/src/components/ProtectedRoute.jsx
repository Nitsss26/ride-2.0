import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  const location = useLocation();

   // Don't redirect while checking auth status
   if (loading) {
     // Optionally return a loading indicator specific to route transition
     return <div className="flex items-center justify-center min-h-screen">Checking authentication...</div>;
   }

  if (!user) {
    // User not logged in, redirect to login page
    // Pass the current location so we can redirect back after login
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // User is logged in, render the requested component
  return children;
};

export default ProtectedRoute;
