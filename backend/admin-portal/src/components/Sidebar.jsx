import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Car,
  Route,
  LifeBuoy,
  Settings,
  LogOut,
  FileCheck2 // Icon for Document Review
} from 'lucide-react'; // Using lucide-react icons
import { useAuth } from '../context/AuthContext';

const Sidebar = () => {
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navLinkClass = ({ isActive }) =>
    `flex items-center px-4 py-2.5 rounded-lg text-sm font-medium transition-colors duration-200 ${
      isActive
        ? 'bg-primary text-primary-foreground'
        : 'text-foreground/70 hover:bg-accent hover:text-accent-foreground'
    }`;

  return (
    <aside className="w-64 bg-card text-card-foreground flex flex-col border-r border-border">
      <div className="px-6 py-4 border-b border-border">
        <h1 className="text-2xl font-bold text-primary">RideVerse Admin</h1>
      </div>
      <nav className="flex-1 px-4 py-4 space-y-2 overflow-y-auto">
        <NavLink to="/dashboard" className={navLinkClass}>
          <LayoutDashboard className="w-5 h-5 mr-3" />
          Dashboard
        </NavLink>
        <NavLink to="/drivers" className={navLinkClass}>
          <Car className="w-5 h-5 mr-3" />
          Drivers
        </NavLink>
         <NavLink to="/drivers/documents" className={navLinkClass}>
            <FileCheck2 className="w-5 h-5 mr-3" />
            Doc Review
        </NavLink>
        <NavLink to="/rides" className={navLinkClass}>
          <Route className="w-5 h-5 mr-3" />
          Rides
        </NavLink>
        <NavLink to="/users" className={navLinkClass}>
          <Users className="w-5 h-5 mr-3" />
          Users
        </NavLink>
        <NavLink to="/support" className={navLinkClass}>
          <LifeBuoy className="w-5 h-5 mr-3" />
          Support Tickets
        </NavLink>
      </nav>
      <div className="px-4 py-4 border-t border-border mt-auto">
        <NavLink to="/settings" className={navLinkClass}>
          <Settings className="w-5 h-5 mr-3" />
          Settings
        </NavLink>
        <button
          onClick={handleLogout}
          className="w-full flex items-center px-4 py-2.5 mt-2 rounded-lg text-sm font-medium text-destructive/80 hover:bg-destructive/10 hover:text-destructive transition-colors duration-200"
        >
          <LogOut className="w-5 h-5 mr-3" />
          Logout
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
