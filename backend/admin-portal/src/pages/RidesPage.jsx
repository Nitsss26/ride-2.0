import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { format } from 'date-fns';

const RidesPage = () => {
  const [rides, setRides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchRides = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await api.get('/rides'); // Use proxy endpoint in admin service
        setRides(response.data || []);
      } catch (err) {
        console.error('Error fetching rides:', err);
        setError('Failed to load rides.');
        setRides([]);
      } finally {
        setLoading(false);
      }
    };

    fetchRides();
  }, []);

   const getStatusColor = (status) => {
      switch (status) {
        case 'completed': return 'text-status-completed';
        case 'in-progress': return 'text-status-inprogress';
        case 'driver_assigned':
        case 'driver_arrived':
             return 'text-status-assigned';
        case 'requested':
        case 'no_drivers_found':
            return 'text-status-pending';
        case 'cancelled_by_rider':
        case 'cancelled_by_driver':
        case 'timed-out':
            return 'text-status-rejected';
        default: return 'text-muted-foreground';
      }
    };


  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold">Ride History</h2>

      {/* TODO: Add Filters (by status, date range, user ID) */}

      {loading && <p className="text-center">Loading rides...</p>}
      {error && <p className="text-center text-destructive">{error}</p>}

      {!loading && !error && (
        <div className="bg-card rounded-lg shadow overflow-hidden border border-border">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-secondary/50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Ride ID</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Rider ID</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Driver ID</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Pickup</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Dropoff</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Fare</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Requested At</th>
              </tr>
            </thead>
            <tbody className="bg-card divide-y divide-border">
              {rides.length === 0 ? (
                 <tr>
                     <td colSpan="8" className="px-6 py-4 text-center text-muted-foreground">No rides found.</td>
                 </tr>
              ) : (
                  rides.map((ride) => (
                    <tr key={ride._id} className="hover:bg-muted/50">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-muted-foreground">{ride._id?.slice(-8) || 'N/A'}</td>
                       <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-muted-foreground">{ride.riderId?.slice(-8) || 'N/A'}</td>
                       <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-muted-foreground">{ride.driverId?.slice(-8) || 'N/A'}</td>
                       <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${getStatusColor(ride.status)}`}>{ride.status?.replace(/_/g, ' ') || 'Unknown'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-foreground max-w-xs truncate">{ride.pickupLocation?.address || 'N/A'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-foreground max-w-xs truncate">{ride.dropoffLocation?.address || 'N/A'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">{ride.fare ? `${ride.fare.amount?.toFixed(2)} ${ride.fare.currency}` : 'N/A'}</td>
                       <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">
                           {ride.createdAt ? format(new Date(ride.createdAt), 'PPpp') : 'N/A'}
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

export default RidesPage;
