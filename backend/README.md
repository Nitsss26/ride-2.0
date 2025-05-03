# RideVerse Backend Microservices

This directory contains the backend microservices for the RideVerse application.

## Architecture Overview

The backend follows a microservice architecture, designed for scalability and resilience. Key components include:

-   **Auth Service:** Handles user (rider/driver) registration, authentication (JWT), and verification.
-   **User Service:** Manages user profiles and status updates.
-   **Ride Service:** Manages the lifecycle of a ride request, status updates, and OTP verification.
-   **Driver Service:** Handles driver profiles, onboarding (info collection), availability, and matching logic.
-   **Notification Service:** Manages real-time communication (WebSocket) for ride offers, status updates, ratings prompts, alerts, etc.
-   **Location Service:** Processes and stores real-time driver location updates via WebSocket and Redis.
-   **Payment Service:** Handles payment processing (cash & in-app simulation), records transactions, and manages simulated earnings.
-   **Support Service:** Manages support tickets for ride issues and disputes.
-   **Analytics Service:** Consumes Kafka events, calculates basic metrics (e.g., ride counts), simulates surge conditions, and provides data.
-   **Admin Service:** Provides a backend for the Admin Portal, handling admin authentication, driver document review/approval, monitoring, and data aggregation.

Infrastructure components used:

-   **MongoDB:** Primary database for storing persistent data (rides, drivers, users, transactions, locations, tickets, etc.).
-   **Redis:** Used for caching, real-time data (driver locations via Geo Sets, driver status), timers (ride timeout, batch expiration), and Pub/Sub for location updates.
-   **Kafka:** Asynchronous messaging bus for inter-service communication (ride requests, driver matches, status updates, payment completion, user creation, analytics events, etc.).
-   **WebSocket:** Used by Notification Service and Location Service for real-time bidirectional communication with mobile apps.

## Prerequisites

-   Docker & Docker Compose
-   Node.js (v18+ recommended)
-   An `.env` file in the `backend` root directory (see `.env.example`). You may need Stripe test keys if implementing fully, but simulation is default.

## Running the Backend (Docker Compose)

1.  **Navigate to the `backend` directory:**
    ```bash
    cd backend
    ```
2.  **Create your environment file:**
    Copy `.env.example` to `.env`. Update `STRIPE_SECRET_KEY` if needed, though Stripe calls are simulated by default.
    ```bash
    cp .env.example .env
    # Edit .env if necessary
    ```
3.  **Build and start the services:**
    ```bash
    docker-compose up --build -d
    ```
    This command will:
    -   Build the Docker images for each service.
    -   Start containers for all services (Node.js apps, Kafka, Zookeeper, Redis, MongoDB).
    -   Run the services in detached mode (`-d`).

4.  **View Logs:**
    To see the logs from all services:
    ```bash
    docker-compose logs -f
    ```
    To view logs for a specific service (e.g., `ride-service`):
    ```bash
    docker-compose logs -f ride-service
    ```

5.  **Stopping the Services:**
    ```bash
    docker-compose down
    ```
    To stop and remove volumes (clears DB data, Kafka topics, etc.):
    ```bash
    docker-compose down -v
    ```

## Service Endpoints (Default Ports)

-   **Auth Service:** `http://localhost:3005`
-   **User Service:** `http://localhost:3006`
-   **Ride Service:** `http://localhost:3000`
-   **Driver Service:** `http://localhost:3001`
-   **Notification Service:** `http://localhost:3002` (HTTP), `ws://localhost:3002` (WebSocket)
-   **Location Service:** `http://localhost:3003` (HTTP), `ws://localhost:3003` (WebSocket for driver updates)
-   **Payment Service:** `http://localhost:3004`
-   **Support Service:** `http://localhost:3007`
-   **Analytics Service:** `http://localhost:3008`
-   **Admin Service (Backend):** `http://localhost:3009`
-   **Admin Portal (Frontend):** `http://localhost:5173` (Served by Vite dev server via Docker)
-   **Kafka:** `localhost:29092` (External listener for host access)
-   **Redis:** `localhost:6379`
-   **MongoDB:** `mongodb://localhost:27017`

## Important Notes

-   **Error Logs:** Each service attempts to log errors to a corresponding `[service-name]-error.log` file within its container volume (`./logs/[service-name]-error.log` on the host).
-   **Kafka Topics:** Topics are set to auto-create in `docker-compose.yml` for development ease.
-   **Redis Keyspace Notifications:** The `docker-compose.yml` configures Redis to emit expiration events (`Ex`). Notification Service uses this (or polling as a fallback).
-   **Error Handling & Resilience:** Basic error handling and logging are included. Production systems require more robust strategies.
-   **Security:** Development setup. Production needs proper security measures.
-   **Simulation:** Features like OTP, Stripe, document handling, payouts, surge logic, and emergency response are simplified or simulated.
-   **Admin Portal:** The admin frontend is built with React (`.jsx`) and served using Vite's development server within Docker for ease of testing. For production, a static build served via Nginx would be more appropriate.

## Testing

Use tools like Postman or `curl` for API testing. WebSocket clients can test Notification/Location services. The React Native apps and the Admin Portal provide end-to-end testing interfaces.
