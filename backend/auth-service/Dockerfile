# Use an official Node runtime as a parent image
FROM node:18-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (or yarn.lock)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Make port ${AUTH_SERVICE_PORT} available to the world outside this container
EXPOSE ${AUTH_SERVICE_PORT:-3005}

# Define the command to run the app
CMD ["npm", "start"]
