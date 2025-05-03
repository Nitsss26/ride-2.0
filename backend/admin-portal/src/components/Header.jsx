import React from 'react';
import { useAuth } from '../context/AuthContext';
import { Bell, UserCircle } from 'lucide-react'; // Example icons

const Header = () => {
  const { user } = useAuth();

  return (
    <header className="bg-card text-card-foreground shadow-sm border-b border-border">
      <div className="container mx-auto px-4 h-16 flex items-center justify-between">
        {/* Left side - Can add search or breadcrumbs later */}
        <div>
          <h2 className="text-lg font-semibold">Admin Portal</h2>
        </div>

        {/* Right side - User info, notifications */}
        <div className="flex items-center space-x-4">
          <button className="p-2 rounded-full hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
            <Bell className="w-5 h-5" />
            <span className="sr-only">Notifications</span>
          </button>
          <div className="flex items-center space-x-2">
            <UserCircle className="w-7 h-7 text-muted-foreground" />
            <span className="text-sm font-medium">{user?.username || 'Admin'}</span>
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
