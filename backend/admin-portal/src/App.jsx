import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import DriversPage from './pages/DriversPage';
import RidesPage from './pages/RidesPage';
import UsersPage from './pages/UsersPage';
import SettingsPage from './pages/SettingsPage';
import SupportPage from './pages/SupportPage';
import DocumentReviewPage from './pages/DocumentReviewPage';
import NotFoundPage from './pages/NotFoundPage';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { useAuth } from './context/AuthContext';

function App() {
  const { loading } = useAuth(); // Use loading state from context

   if (loading) {
    // You can show a global loading spinner here if needed
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        {/* Nested routes within the layout */}
        <Route index element={<Navigate replace to="/dashboard" />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="drivers" element={<DriversPage />} />
         <Route path="drivers/documents" element={<DocumentReviewPage />} />
        <Route path="rides" element={<RidesPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="support" element={<SupportPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export default App;
