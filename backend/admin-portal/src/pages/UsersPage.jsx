import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { Users, Mail, Phone, Ban, CheckCircle } from 'lucide-react';

const UsersPage = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterRole, setFilterRole] = useState('rider'); // Default to riders

  useEffect(() => {
    fetchUsers();
  }, [filterRole]);

  const fetchUsers = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get(`/users?role=${filterRole}`); // Filter by role via User Service
      setUsers(response.data || []);
    } catch (err) {
      console.error(`Error fetching ${filterRole}s:`, err);
      setError(`Failed to load ${filterRole}s.`);
      setUsers([]);
    } finally {
      setLoading(false);
    }
  };

  const handleStatusUpdate = async (userId, newStatus) => {
     if (!window.confirm(`Are you sure you want to set status to ${newStatus} for user ${userId}?`)) {
         return;
     }
     try {
         await api.put(`/users/${userId}/status`, { accountStatus: newStatus });
         // Refetch users to show updated status
         fetchUsers();
         alert(`User status updated to ${newStatus}.`);
     } catch (err) {
         console.error(`Error updating user ${userId} status:`, err);
         alert(`Failed to update status: ${err.response?.data?.message || err.message}`);
     }
   };

    const getStatusBadge = (status) => {
     switch (status) {
       case 'active':
         return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-approved/20 text-status-approved"><CheckCircle className="w-3 h-3 mr-1" /> Active</span>;
       case 'pending_verification':
         return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-pending/20 text-status-pending">Pending Verification</span>;
        case 'pending_approval': // Should not apply to riders typically
           return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-pending/20 text-status-pending">Pending Approval</span>;
       case 'suspended':
         return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-suspended/20 text-status-suspended"><Ban className="w-3 h-3 mr-1" /> Suspended</span>;
       case 'banned':
            return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-rejected/20 text-status-rejected"><Ban className="w-3 h-3 mr-1" /> Banned</span>;
       default:
         return <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted/50 text-muted-foreground">{status || 'Unknown'}</span>;
     }
   };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-semibold">User Management ({filterRole === 'rider' ? 'Riders' : 'Unknown'})</h2>
        {/* Add filter/search options later */}
      </div>

      {/* TODO: Add Filters (by status, search) */}

      {loading && <p className="text-center">Loading users...</p>}
      {error && <p className="text-center text-destructive">{error}</p>}

      {!loading && !error && (
        <div className="bg-card rounded-lg shadow overflow-hidden border border-border">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-secondary/50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">User ID</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Email</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Phone</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-card divide-y divide-border">
              {users.length === 0 ? (
                  <tr>
                      <td colSpan="6" className="px-6 py-4 text-center text-muted-foreground">No users found.</td>
                  </tr>
              ) : (
                  users.map((user) => (
                    <tr key={user._id} className="hover:bg-muted/50">
                       <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-muted-foreground">{user._id?.slice(-8) || 'N/A'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-foreground">{user.name || 'N/A'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">{user.email}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-muted-foreground">{user.phone || 'N/A'}</td>
                       <td className="px-6 py-4 whitespace-nowrap text-sm">{getStatusBadge(user.accountStatus)}</td>
                        <td className="px-6 py-4 whitespace-nowrap text-sm space-x-2">
                           {/* Add actions like View Details, Suspend, Activate */}
                            {user.accountStatus === 'active' && (
                                <button onClick={() => handleStatusUpdate(user._id, 'suspended')} className="text-xs text-status-suspended hover:underline">Suspend</button>
                            )}
                            {user.accountStatus === 'suspended' && (
                                <button onClick={() => handleStatusUpdate(user._id, 'active')} className="text-xs text-status-approved hover:underline">Activate</button>
                            )}
                             {user.accountStatus !== 'banned' && (
                                <button onClick={() => handleStatusUpdate(user._id, 'banned')} className="text-xs text-status-rejected hover:underline">Ban</button>
                            )}
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

export default UsersPage;
