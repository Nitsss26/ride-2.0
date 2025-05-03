import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173, // Ensure Vite runs on the exposed port
    host: '0.0.0.0', // Listen on all network interfaces within the container
    watch: {
      usePolling: true, // Necessary for Docker volume mapping changes to be detected sometimes
    },
  },
   define: {
    // Make environment variables available in the client-side code
    'process.env.VITE_ADMIN_SERVICE_URL': JSON.stringify(process.env.VITE_ADMIN_SERVICE_URL || 'http://localhost:3009')
  }
})
