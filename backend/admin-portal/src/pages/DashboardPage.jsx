import React, { useState, useEffect } from 'react';
import api from '../services/api';
import StatCard from '../components/StatCard';
import { Users, Car, Route, BarChart, AlertTriangle } from 'lucide-react';
// Placeholder for charts - replace with actual chart library (e.g., Chart.js, Recharts)
import { Line } from 'react-chartjs-2';
import { Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend } from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);


const DashboardPage = () => {
  const [stats, setStats] = useState({
    totalDrivers: 0,
    onlineDrivers: 0,
    totalRiders: 0,
    activeRides: 0,
    ridesToday: 0,
    earningsToday: 0,
    pendingDocs: 0,
    openTickets: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [chartData, setChartData] = useState(null);

  useEffect(() => {
    const fetchDashboardData = async () => {
      setLoading(true);
      setError('');
      try {
        // --- Fetch Real Data (Simulated) ---
        // In a real app, these would be separate API calls or one aggregated call

        // Simulate fetching analytics summary
        const summaryRes = await api.get('/analytics/summary/today');
        const summary = summaryRes.data || {};

        // Simulate fetching driver counts (needs new endpoints)
        // const driversRes = await api.get('/drivers?count=true&status=online');
        const totalDrivers = Math.floor(Math.random() * 500) + 50; // Simulate
        const onlineDrivers = Math.floor(Math.random() * totalDrivers * 0.3); // Simulate

        // Simulate fetching user counts
        // const usersRes = await api.get('/users?role=rider&count=true');
        const totalRiders = Math.floor(Math.random() * 5000) + 1000; // Simulate

        // Simulate fetching active rides (needs new endpoint)
        // const activeRidesRes = await api.get('/rides?status=in-progress,assigned,arrived&count=true');
        const activeRides = Math.floor(Math.random() * 50) + 5; // Simulate

         // Simulate pending documents
        const pendingDocsRes = await api.get('/documents/pending'); // Assuming this exists
        const pendingDocsCount = pendingDocsRes.data?.length || 0;

        // Simulate open tickets
        // const openTicketsRes = await api.get('/support/tickets?status=open&count=true');
        const openTicketsCount = Math.floor(Math.random() * 20); // Simulate

        setStats({
          totalDrivers: totalDrivers,
          onlineDrivers: onlineDrivers,
          totalRiders: totalRiders,
          activeRides: activeRides,
          ridesToday: summary.totalRidesCompleted || 0,
          earningsToday: summary.totalEarnings || 0,
          pendingDocs: pendingDocsCount,
          openTickets: openTicketsCount,
        });

        // Simulate chart data (e.g., rides per hour for the last 24 hours)
         const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
         const rideData = labels.map(() => Math.floor(Math.random() * 30) + 5);
         setChartData({
           labels,
           datasets: [
             {
               label: 'Rides per Hour (Last 24h)',
               data: rideData,
               borderColor: 'hsl(180 100% 25%)', // Teal
               backgroundColor: 'hsla(180, 100%, 25%, 0.2)',
               fill: true,
               tension: 0.3,
             },
           ],
         });


      } catch (err) {
        console.error('Error fetching dashboard data:', err);
        setError('Failed to load dashboard data.');
         // Use dummy data on error to prevent crash
         setStats({ totalDrivers: 150, onlineDrivers: 35, totalRiders: 2500, activeRides: 20, ridesToday: 180, earningsToday: 1250.75, pendingDocs: 5, openTickets: 3 });
         // Provide dummy chart data as well
         const labels = Array.from({ length: 24 }, (_, i) => `${i}:00`);
         const rideData = labels.map(() => Math.floor(Math.random() * 30) + 5);
         setChartData({ labels, datasets: [{ label: 'Rides per Hour (Simulated)', data: rideData, borderColor: 'hsl(180 100% 25%)', backgroundColor: 'hsla(180, 100%, 25%, 0.2)', fill: true, tension: 0.3 }] });

      } finally {
        setLoading(false);
      }
    };

    fetchDashboardData();
  }, []);

  if (loading) {
    return <div className="text-center p-8">Loading dashboard data...</div>;
  }

  if (error) {
      return <div className="text-center p-8 text-destructive">{error}</div>;
  }

   const chartOptions = {
      responsive: true,
      plugins: {
        legend: { position: 'top' },
        title: { display: true, text: 'Ride Activity Overview' },
      },
      scales: { y: { beginAtZero: true } }
    };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold">Dashboard Overview</h2>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        <StatCard title="Total Drivers" value={stats.totalDrivers} icon={Car} />
        <StatCard title="Online Drivers" value={stats.onlineDrivers} icon={Car} color="text-status-active" />
        <StatCard title="Total Riders" value={stats.totalRiders} icon={Users} />
        <StatCard title="Active Rides" value={stats.activeRides} icon={Route} color="text-status-inprogress" />
        <StatCard title="Rides Today" value={stats.ridesToday} icon={BarChart} />
        <StatCard title="Earnings Today" value={`$${stats.earningsToday.toFixed(2)}`} icon={BarChart} />
        <StatCard title="Pending Documents" value={stats.pendingDocs} icon={FileCheck2} color={stats.pendingDocs > 0 ? "text-status-pending" : undefined} />
        <StatCard title="Open Tickets" value={stats.openTickets} icon={AlertTriangle} color={stats.openTickets > 0 ? "text-status-rejected" : undefined} />
      </div>

      {/* Charts Section */}
       <div className="mt-8 bg-card p-4 rounded-lg shadow">
         <h3 className="text-lg font-semibold mb-4">Recent Activity</h3>
          {chartData ? (
            <Line options={chartOptions} data={chartData} />
          ) : (
             <p className="text-muted-foreground">Chart data is loading or unavailable.</p>
          )}
       </div>


      {/* Add more sections like Recent Activity Feed, Alerts, etc. */}

    </div>
  );
};

export default DashboardPage;
