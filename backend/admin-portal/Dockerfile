# Stage 1: Build the React application
# FROM node:18-alpine as builder
# WORKDIR /app
# COPY package*.json ./
# RUN npm install
# COPY . .
# RUN npm run build

# Stage 2: Serve the application using Vite's development server (for ease of use in dev)
FROM node:18-alpine
WORKDIR /app

# Copy dependency definitions
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application source code
COPY . .

# Expose the Vite development server port
EXPOSE 5173

# Start the Vite development server, accessible from outside the container
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]

# --- Production Build (Alternative) ---
# If you wanted a production build served by a static server (like Nginx):
# FROM nginx:stable-alpine
# COPY --from=builder /app/dist /usr/share/nginx/html
# COPY nginx.conf /etc/nginx/conf.d/default.conf # Create an nginx.conf for SPA routing
# EXPOSE 80
# CMD ["nginx", "-g", "daemon off;"]
