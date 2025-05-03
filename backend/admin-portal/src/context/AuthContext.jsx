import React, { createContext, useState, useContext, useEffect } from 'react';
import api from '../services/api'; // Import configured axios instance

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true); // Add loading state

  useEffect(() => {
    // Check for existing token on initial load
    const token = localStorage.getItem('adminToken');
    if (token) {
       // Validate token with backend (optional but recommended)
       // For now, just decode and set user if token exists
       api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
       // Decode token to get user info (simple decode, doesn't verify signature here)
        try {
            // WARNING: In a real app, always verify the token signature on the backend!
            // This basic decoding is just for demonstration.
            const decoded = JSON.parse(atob(token.split('.')[1])); // Simple base64 decode
            if (decoded.exp * 1000 > Date.now()) { // Check expiry
                 setUser({ id: decoded.userId, username: decoded.username, role: decoded.role });
            } else {
                localStorage.removeItem('adminToken'); // Remove expired token
            }
        } catch (error) {
            console.error("Error decoding token:", error);
            localStorage.removeItem('adminToken');
        }
    }
    setLoading(false); // Finished initial auth check
  }, []);

  const login = async (username, password) => {
     setLoading(true);
     try {
      const response = await api.post('/auth/login', { username, password });
      const { token, user: loggedInUser } = response.data;
      localStorage.setItem('adminToken', token);
      api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      setUser(loggedInUser);
      setLoading(false);
      return true; // Indicate success
    } catch (error) {
      console.error('Login failed:', error);
      setUser(null);
      localStorage.removeItem('adminToken');
      delete api.defaults.headers.common['Authorization'];
       setLoading(false);
      return false; // Indicate failure
    }
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem('adminToken');
    delete api.defaults.headers.common['Authorization'];
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
