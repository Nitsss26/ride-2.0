import React from 'react';

const StatCard = ({ title, value, icon: Icon, color = 'text-primary' }) => {
  return (
    <div className="bg-card p-4 rounded-lg shadow border border-border">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        {Icon && <Icon className={`w-5 h-5 ${color}`} />}
      </div>
      <p className="mt-2 text-2xl font-semibold text-foreground">{value}</p>
      {/* Optional: Add a change indicator or link */}
      {/* <p className="text-xs text-muted-foreground mt-1">+2% from yesterday</p> */}
    </div>
  );
};

export default StatCard;
