import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { Car, ShieldCheck, ShieldAlert, Search, UserCog, Ban } from 'lucide-react'; // Add UserCog, Ban

const DriversPage = () => {
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState(''); // '', 'active', 'pending_approval', 'suspended', etc.

  useEffect(() => {
    fetchDrivers();
  }, []); // Fetch on initial load

   const fetchDrivers = async (params = {}) => {
    setLoading(true);
    setError('');
    try {
       // Construct query parameters
      const queryParams = new URLSearchParams(params);
      if (searchTerm) queryParams.set('search', searchTerm); // Assuming backend supports search
      if (filterStatus) queryParams.set('accountStatus', filterStatus);
      queryParams.set('role', 'driver'); // Ensure we only get drivers

      const response = await api.get(`/users?${queryParams.toString()}`); // Use User service endpoint
      setDrivers(response.data || []); // Assuming response.data is an array
    } catch (err) {
      console.error('Error fetching drivers:', err);
      setError('Failed to load drivers.');
      setDrivers([]); // Clear drivers on error
    } finally {
      setLoading(false);
    }
  };

   const handleSearch = (e) => {
     e.preventDefault();
     fetchDrivers({ search: searchTerm, accountStatus: filterStatus });
   };

   const handleFilterChange = (e) => {
     setFilterStatus(e.target.value);
     fetchDrivers({ search: searchTerm, accountStatus: e.target.value });
   };

   const handleStatusUpdate = async (driverId, newStatus) => {
     if (!window.confirm(`Are you sure you want to set status to ${newStatus} for driver ${driverId}?`)) {
         return;
     }
     try {
         await api.put(`/users/${driverId}/status`, { accountStatus: newStatus });
         // Refetch drivers to show updated status
         fetchDrivers({ search: searchTerm, accountStatus: filterStatus });
         alert(`Driver status updated to ${newStatus}.`);
     } catch (err) {
         console.error(`Error updating driver ${driverId} status:`, err);
         alert(`Failed to update status: ${err.response?.data?.message || err.message}`);
     }
   };


  const getStatusBadge = (status) => {
    switch (status) {
      case 'active':
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-approved/20 text-status-approved"><ShieldCheck className="w-3 h-3 mr-1" /> Active</span>;
      case 'pending_approval':
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-pending/20 text-status-pending"><UserCog className="w-3 h-3 mr-1" /> Pending Approval</span>;
      case 'pending_verification':
          return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-pending/20 text-status-pending"><UserCog className="w-3 h-3 mr-1" /> Pending Verification</span>;
      case 'suspended':
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-suspended/20 text-status-suspended"><Ban className="w-3 h-3 mr-1" /> Suspended</span>;
       case 'banned':
       case 'rejected':
           return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-rejected/20 text-status-rejected"><Ban className="w-3 h-3 mr-1" /> {status.charAt(0).toUpperCase() + status.slice(1)}</span>;
      default:
        return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted/50 text-muted-foreground">{status || 'Unknown'}</span>;
    }
  };


  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold">Driver Management</h2>

       {/* Search and Filter */}
       <div className="flex flex-col sm:flex-row gap-4 mb-4 items-center">
         <form onSubmit={handleSearch} className="flex-1 flex gap-2">
             <input
               type="text"
               placeholder="Search by name, email, or ID..."
               value={searchTerm}
               onChange={(e) => setSearchTerm(e.target.value)}
               className="block w-full px-3 py-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-primary focus:border-primary sm:text-sm bg-background text-foreground"
             />
             <button type="submit" className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-primary-foreground bg-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary">
               <Search className="w-4 h-4"/>
             </button>
         </form>
          <select
              value={filterStatus}
              onChange={handleFilterChange}
              className="px-3 py-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-primary focus:border-primary sm:text-sm bg-background text-foreground"
            >
              <option value="">All Statuses</option>
              <option value="active">Active</option>
              <option value="pending_approval">Pending Approval</option>
              <option value="pending_verification">Pending Verification</option>
              <option value="suspended">Suspended</option>
              <option value="banned">Banned</option>
               <option value="rejected">Rejected</option>
          </select>
       </div>


      {loading && <p className="text-center">Loading drivers...</p>}
      {error && <p className="text-center text-destructive">{error}</p>}

      {!loading && !error && (
        <div className="bg-card rounded-lg shadow overflow-hidden border border-border">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-secondary/50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Email</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Vehicle</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                 <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-card divide-y divide-border">
              {drivers.length === 0 ? (
                  <tr>
                      <td colSpan="6" className="px-6 py-4 text-center text-muted-foreground">No drivers found.</td>
                  </tr>
              ) : (
                  drivers.map((driver) => (
                    <tr key={driver._id} className="hover:bg-muted/50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-foreground">{driver.name || 'N/A'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">{driver.email}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">{driver.phone || 'N/A'}</td>
                       <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                           {driver.driverDetails?.vehicleInfo ? `${driver.driverDetails.vehicleInfo.make} ${driver.driverDetails.vehicleInfo.model} (${driver.driverDetails.vehicleInfo.licensePlate})` : 'N/A'}
                       </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm">{getStatusBadge(driver.accountStatus)}</td>
                       <td className="px-6 py-4 whitespace-nowrap text-sm space-x-2">
                           {/* Add actions like View Details, Suspend, Activate */}
                            {driver.accountStatus !== 'active' && driver.accountStatus !== 'pending_verification' && driver.accountStatus !== 'pending_approval' && (
                                <button onClick={() => handleStatusUpdate(driver._id, 'active')} className="text-xs text-status-approved hover:underline">Activate</button>
                            )}
                            {driver.accountStatus === 'active' && (
                                <button onClick={() => handleStatusUpdate(driver._id, 'suspended')} className="text-xs text-status-suspended hover:underline">Suspend</button>
                            )}
                           {/* Add more actions as needed */}
                        </td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </div>
      )}
      {/* TODO: Add Pagination */}
    </div>
  );
};

export default DriversPage;
