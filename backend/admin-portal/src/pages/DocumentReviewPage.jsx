import React, { useState, useEffect } from 'react';
import api from '../services/api';
import { format } from 'date-fns';
import { Check, X, FileText, ExternalLink, AlertCircle } from 'lucide-react';

const DocumentReviewPage = () => {
  const [pendingDocs, setPendingDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');

  useEffect(() => {
    fetchPendingDocuments();
  }, []);

  const fetchPendingDocuments = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/documents/pending');
      setPendingDocs(response.data || []);
      setSelectedDoc(response.data?.[0] || null); // Select the first one by default
    } catch (err) {
      console.error('Error fetching pending documents:', err);
      setError('Failed to load documents for review.');
      setPendingDocs([]);
    } finally {
      setLoading(false);
    }
  };

   const handleSelectDocument = (doc) => {
      setSelectedDoc(doc);
      setRejectionReason(''); // Clear reason when changing doc
   };

    const handleUpdateStatus = async (newStatus) => {
        if (!selectedDoc) return;
        if (newStatus === 'rejected' && !rejectionReason.trim()) {
            alert('Please provide a reason for rejection.');
            return;
        }

        try {
            const payload = { status: newStatus };
            if (newStatus === 'rejected') {
                payload.rejectionReason = rejectionReason.trim();
            }
            await api.put(`/documents/${selectedDoc._id}/status`, payload);
            alert(`Document ${newStatus}.`);
            fetchPendingDocuments(); // Refresh list
        } catch (err) {
             console.error('Error updating document status:', err);
             alert(`Failed to update status: ${err.response?.data?.message || err.message}`);
        }
    };


  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold">Driver Document Review</h2>

      {loading && <p className="text-center">Loading documents...</p>}
      {error && <p className="text-center text-destructive">{error}</p>}

      {!loading && !error && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Document List */}
          <div className="lg:col-span-1 bg-card rounded-lg shadow border border-border overflow-y-auto max-h-[calc(100vh-10rem)]">
            <h3 className="text-md font-semibold p-4 border-b border-border">Pending Review ({pendingDocs.length})</h3>
            <ul className="divide-y divide-border">
              {pendingDocs.length === 0 ? (
                <li className="p-4 text-center text-muted-foreground">No documents pending review.</li>
              ) : (
                pendingDocs.map((doc) => (
                  <li key={doc._id} className={`p-3 hover:bg-muted/50 cursor-pointer ${selectedDoc?._id === doc._id ? 'bg-accent/10' : ''}`} onClick={() => handleSelectDocument(doc)}>
                    <div className="flex items-center justify-between text-sm mb-1">
                       <span className="font-medium flex items-center">
                           <FileText className="w-4 h-4 mr-1.5 text-muted-foreground"/>
                           {doc.documentType.replace('_',' ').toUpperCase()}
                       </span>
                       <span className="text-xs text-muted-foreground">
                           {format(new Date(doc.uploadedAt), 'PP')}
                       </span>
                    </div>
                     <p className="text-xs text-muted-foreground">Driver: {doc.driverId.slice(-8)}</p>
                      {doc.expiryDate && new Date(doc.expiryDate) < new Date() && (
                           <p className="text-xs text-destructive mt-1 flex items-center"><AlertCircle className="w-3 h-3 mr-1"/> Expired</p>
                      )}
                       {doc.expiryDate && new Date(doc.expiryDate) >= new Date() && (
                           <p className="text-xs text-muted-foreground mt-1">Expires: {format(new Date(doc.expiryDate), 'P')}</p>
                       )}
                  </li>
                ))
              )}
            </ul>
          </div>

          {/* Document Viewer & Actions */}
          <div className="lg:col-span-2 bg-card rounded-lg shadow p-6 border border-border">
            {selectedDoc ? (
              <div className="space-y-4">
                <h3 className="text-lg font-semibold">Review Document</h3>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                   <p><strong className="text-muted-foreground">Driver ID:</strong> {selectedDoc.driverId}</p>
                   <p><strong className="text-muted-foreground">Document Type:</strong> {selectedDoc.documentType.replace('_', ' ').toUpperCase()}</p>
                   <p><strong className="text-muted-foreground">Uploaded:</strong> {format(new Date(selectedDoc.uploadedAt), 'PPpp')}</p>
                   {selectedDoc.expiryDate && <p><strong className="text-muted-foreground">Expires:</strong> {format(new Date(selectedDoc.expiryDate), 'P')}</p>}
                </div>

                {/* Document Viewer (Placeholder - needs secure viewer/link) */}
                <div className="border border-border rounded p-4 bg-secondary/30 min-h-[300px] flex flex-col items-center justify-center">
                  {/* In a real app, use a secure iframe, image tag, or PDF viewer */}
                   <FileText className="w-16 h-16 text-muted-foreground mb-4"/>
                   <a
                       href={selectedDoc.documentUrl}
                       target="_blank"
                       rel="noopener noreferrer"
                       className="inline-flex items-center px-4 py-2 border border-border rounded-md shadow-sm text-sm font-medium text-foreground bg-background hover:bg-muted focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring"
                   >
                       View Document <ExternalLink className="w-4 h-4 ml-2"/>
                   </a>
                   <p className="text-xs text-muted-foreground mt-2">(Opens in new tab)</p>
                </div>

                 {/* Actions */}
                 <div className="pt-4 border-t border-border space-y-3">
                    <h4 className="text-md font-semibold">Actions</h4>
                    <textarea
                        rows="2"
                        placeholder="Add rejection reason (required if rejecting)..."
                        value={rejectionReason}
                        onChange={(e) => setRejectionReason(e.target.value)}
                         className="block w-full px-3 py-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-primary focus:border-primary sm:text-sm bg-background text-foreground"
                      />
                    <div className="flex gap-3">
                         <button onClick={() => handleUpdateStatus('approved')} className="flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-status-approved hover:bg-status-approved/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500">
                             <Check className="w-4 h-4 mr-2"/> Approve
                         </button>
                         <button onClick={() => handleUpdateStatus('rejected')} disabled={!rejectionReason.trim()} className="flex items-center justify-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-status-rejected hover:bg-status-rejected/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50">
                             <X className="w-4 h-4 mr-2"/> Reject
                         </button>
                    </div>
                 </div>

              </div>
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-muted-foreground">{pendingDocs.length > 0 ? 'Select a document to review.' : 'No documents awaiting review.'}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DocumentReviewPage;
