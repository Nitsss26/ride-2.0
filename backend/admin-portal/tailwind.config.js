/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
       colors: {
            // Matching the light theme from globals.css for consistency
            background: 'hsl(0 0% 100%)', // White
            foreground: 'hsl(0 0% 20%)', // Dark Gray (#333333)
            primary: {
                DEFAULT: 'hsl(180 100% 25%)', // Teal (#008080)
                foreground: 'hsl(0 0% 100%)', // White
            },
            secondary: {
                DEFAULT: 'hsl(0 0% 96.1%)', // Light Gray
                foreground: 'hsl(0 0% 9%)', // Near Black
            },
            muted: {
                DEFAULT: 'hsl(0 0% 96.1%)',
                foreground: 'hsl(0 0% 45.1%)',
            },
            accent: {
                DEFAULT: 'hsl(180 100% 25%)', // Teal
                foreground: 'hsl(0 0% 100%)', // White
            },
            destructive: {
                DEFAULT: 'hsl(0 84.2% 60.2%)', // Red
                foreground: 'hsl(0 0% 98%)',
            },
            border: 'hsl(0 0% 89.8%)',
            input: 'hsl(0 0% 89.8%)',
            ring: 'hsl(180 100% 25%)', // Teal for focus rings
            card: {
                 DEFAULT: 'hsl(0 0% 100%)',
                 foreground: 'hsl(0 0% 20%)',
            },
            popover: {
                 DEFAULT: 'hsl(0 0% 100%)',
                 foreground: 'hsl(0 0% 20%)',
            },
            // Status colors
            status: {
                pending: 'hsl(48 96% 50%)', // Yellow
                approved: 'hsl(142 71% 45%)', // Green
                rejected: 'hsl(0 84.2% 60.2%)', // Red
                active: 'hsl(142 71% 45%)', // Green
                inactive: 'hsl(0 0% 45.1%)', // Muted Foreground
                suspended: 'hsl(38 92% 50%)', // Orange
                banned: 'hsl(0 84.2% 60.2%)', // Red
                completed: 'hsl(210 40% 96.1%)', // Light blue/gray
                inprogress: 'hsl(205 90% 76%)', // Sky blue
                assigned: 'hsl(180 100% 25%)', // Teal
                requested: 'hsl(48 96% 50%)', // Yellow
            }
        },
        borderRadius: {
             lg: '0.5rem',
             md: 'calc(0.5rem - 2px)',
             sm: 'calc(0.5rem - 4px)',
         },
    },
  },
  plugins: [],
}
