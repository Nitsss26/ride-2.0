import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { format, formatDistanceToNow } from 'date-fns';
import { AlertTriangle, CheckCircle, Clock, MessageSquare, User, Route } from 'lucide-react';

const SupportPage = () => {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterStatus, setFilterStatus] = useState('open'); // Default to open tickets
  const [selectedTicket, setSelectedTicket] = useState(null); // For viewing details
  const [resolutionNotes, setResolutionNotes] = useState('');

  useEffect(() => {
    fetchTickets();
  }, [filterStatus]);

  const fetchTickets = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get(`/support/tickets?status=${filterStatus}`); // Use proxy endpoint
      setTickets(response.data || []);
      setSelectedTicket(null); // Clear selection when refetching
    } catch (err) {
      console.error('Error fetching support tickets:', err);
      setError('Failed to load support tickets.');
      setTickets([]);
    } finally {
      setLoading(false);
    }
  };

  const handleViewDetails = async (ticketId) => {
    try {
        const response = await api.get(`/support/tickets/${ticketId}`);
        setSelectedTicket(response.data);
        setResolutionNotes(''); // Clear notes when viewing a new ticket
    } catch (err) {
        console.error('Error fetching ticket details:', err);
        alert('Failed to load ticket details.');
    }
  };

  const handleUpdateStatus = async (newStatus) => {
     if (!selectedTicket) return;
     if (newStatus === 'resolved' && !resolutionNotes.trim()) {
         alert('Please add resolution notes before resolving the ticket.');
         return;
     }

     try {
          const payload = { status: newStatus };
          if (newStatus === 'resolved') {
              payload.resolutionNotes = resolutionNotes.trim();
          }
          await api.put(`/support/tickets/${selectedTicket._id}`, payload);
          alert(`Ticket status updated to ${newStatus}.`);
          fetchTickets(); // Refresh the list
     } catch (err) {
         console.error('Error updating ticket status:', err);
         alert(`Failed to update status: ${err.response?.data?.message || err.message}`);
     }
  };


  const getSeverityBadge = (severity) => {
    switch (severity) {
      case 'critical': return 'bg-red-600 text-white';
      case 'high': return 'bg-red-400 text-red-900';
      case 'medium': return 'bg-yellow-400 text-yellow-900';
      case 'low':
      default: return 'bg-blue-400 text-blue-900';
    }
  };

   const getStatusColor = (status) => {
      switch (status) {
        case 'open': return 'text-status-pending';
        case 'in_progress': return 'text-status-inprogress';
        case 'resolved':
        case 'closed':
             return 'text-status-approved';
        case 'escalated':
            return 'text-status-rejected'; // Use rejected color for escalated?
        default: return 'text-muted-foreground';
      }
    };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-semibold">Support Tickets</h2>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-primary focus:border-primary sm:text-sm bg-background text-foreground"
        >
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
          <option value="escalated">Escalated</option>
          <option value="">All</option>
        </select>
      </div>

      {loading && <p className="text-center">Loading tickets...</p>}
      {error && <p className="text-center text-destructive">{error}</p>}

      {!loading && !error && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Ticket List */}
          <div className="lg:col-span-1 bg-card rounded-lg shadow border border-border overflow-y-auto max-h-[calc(100vh-10rem)]">
            <ul className="divide-y divide-border">
             {tickets.length === 0 ? (
                 <li className="p-4 text-center text-muted-foreground">No {filterStatus || 'active'} tickets found.</li>
             ) : (
              tickets.map((ticket) => (
                <li key={ticket._id} className={`p-4 hover:bg-muted/50 cursor-pointer ${selectedTicket?._id === ticket._id ? 'bg-accent/10' : ''}`} onClick={() => handleViewDetails(ticket._id)}>
                  <div className="flex justify-between items-start mb-1">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${getSeverityBadge(ticket.severity)}`}>
                      {ticket.severity}
                    </span>
                    <span className={`text-xs font-medium ${getStatusColor(ticket.status)}`}>{ticket.status.replace('_', ' ')}</span>
                  </div>
                  <p className="text-sm font-semibold text-foreground mb-1">{ticket.issueType.replace(/_/g, ' ')}</p>
                  <p className="text-xs text-muted-foreground truncate mb-1">{ticket.description}</p>
                   <div className="flex justify-between items-center text-xs text-muted-foreground">
                      <span>{ticket.userRole}: {ticket.userId?.slice(-6)}</span>
                       <span>{formatDistanceToNow(new Date(ticket.createdAt), { addSuffix: true })}</span>
                  </div>
                </li>
              ))
             )}
            </ul>
          </div>

          {/* Ticket Details */}
          <div className="lg:col-span-2 bg-card rounded-lg shadow p-6 border border-border">
            {selectedTicket ? (
              <div className="space-y-4">
                <div className="flex justify-between items-center pb-2 border-b border-border">
                    <h3 className="text-lg font-semibold">Ticket Details (#{selectedTicket._id.slice(-8)})</h3>
                     <span className={`text-sm font-medium ${getStatusColor(selectedTicket.status)}`}>{selectedTicket.status.replace('_', ' ')}</span>
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><strong className="text-muted-foreground block">User ID:</strong> {selectedTicket.userId} ({selectedTicket.userRole})</div>
                   <div><strong className="text-muted-foreground block">Issue Type:</strong> {selectedTicket.issueType.replace(/_/g, ' ')}</div>
                   <div><strong className="text-muted-foreground block">Severity:</strong> <span className={`px-1.5 py-0.5 rounded text-xs ${getSeverityBadge(selectedTicket.severity)}`}>{selectedTicket.severity}</span></div>
                  <div><strong className="text-muted-foreground block">Ride ID:</strong> {selectedTicket.rideId || 'N/A'}</div>
                  <div><strong className="text-muted-foreground block">Created:</strong> {format(new Date(selectedTicket.createdAt), 'PPpp')}</div>
                   <div><strong className="text-muted-foreground block">Updated:</strong> {format(new Date(selectedTicket.updatedAt), 'PPpp')}</div>
                </div>
                 <div><strong className="text-muted-foreground block text-sm">Description:</strong> <p className="mt-1 text-sm bg-secondary/30 p-2 rounded">{selectedTicket.description}</p></div>

                {selectedTicket.resolutionNotes && (
                   <div><strong className="text-muted-foreground block text-sm">Resolution Notes:</strong> <p className="mt-1 text-sm bg-green-100 text-green-800 p-2 rounded">{selectedTicket.resolutionNotes}</p></div>
                )}

                 {/* Actions for Open/In Progress tickets */}
                {(selectedTicket.status === 'open' || selectedTicket.status === 'in_progress') && (
                    <div className="pt-4 border-t border-border space-y-3">
                         <h4 className="text-md font-semibold">Actions</h4>
                         <textarea
                            rows="3"
                            placeholder="Add resolution notes (required for resolving)..."
                            value={resolutionNotes}
                            onChange={(e) => setResolutionNotes(e.target.value)}
                             className="block w-full px-3 py-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-primary focus:border-primary sm:text-sm bg-background text-foreground"
                          />
                        <div className="flex gap-2">
                             {selectedTicket.status === 'open' && (
                                <button onClick={() => handleUpdateStatus('in_progress')} className="px-3 py-1.5 border border-transparent rounded-md shadow-sm text-xs font-medium text-white bg-blue-600 hover:bg-blue-700">Mark In Progress</button>
                            )}
                            <button onClick={() => handleUpdateStatus('resolved')} disabled={!resolutionNotes.trim()} className="px-3 py-1.5 border border-transparent rounded-md shadow-sm text-xs font-medium text-white bg-status-approved hover:bg-status-approved/90 disabled:opacity-50">Resolve Ticket</button>
                            {/* Add Escalate button maybe */}
                        </div>
                    </div>
                 )}

              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-muted-foreground">Select a ticket to view details.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SupportPage;
