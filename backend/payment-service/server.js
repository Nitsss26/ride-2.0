require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { connectKafkaProducer, getKafkaProducer, disconnectKafka } = require('./kafkaClient');
const Transaction = require('./models/Transaction');
const { logError } = require('../utils/logger'); // Import logger

// --- Stripe Initialization ---
// Use a placeholder key if STRIPE_SECRET_KEY is not set or is 'sk_test_SIMULATED'
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const isStripeSimulated = !STRIPE_SECRET || STRIPE_SECRET === 'sk_test_SIMULATED';
let stripe;
if (!isStripeSimulated) {
    try {
        stripe = require('stripe')(STRIPE_SECRET);
        console.log("Stripe initialized with provided key.");
    } catch (e) {
         logError('payment-service', e, 'Stripe Initialization Failed');
         console.error("FATAL: Failed to initialize Stripe with provided key. Using simulation.", e.message);
         // Fallback to simulation if init fails
         // stripe = null; // Ensure stripe is null if init fails
    }
} else {
    console.warn("Stripe secret key not provided or set to simulation value. Stripe payments will be simulated.");
    // stripe = null; // Ensure stripe is null in simulation mode
}

const app = express();
app.use(express.json());

const MONGODB_URI = process.env.PAYMENT_SERVICE_MONGODB_URI || 'mongodb://localhost:27017/payment_service';
const SERVICE_NAME = 'payment-service';

let isKafkaProducerConnected = false;

// --- Database Connection ---
mongoose.connect(MONGODB_URI)
  .then(() => console.log('PaymentService MongoDB connected'))
  .catch(err => {
      logError(SERVICE_NAME, err, 'MongoDB Connection');
      console.error('PaymentService MongoDB connection error:', err);
      process.exit(1); // Exit if DB fails
  });

// --- Kafka Connection ---
connectKafkaProducer().then(connected => {
    isKafkaProducerConnected = connected;
    if(connected) console.log('PaymentService Kafka Producer connected');
    else console.warn('PaymentService Kafka Producer connection failed. Completion events will not be published.');
}).catch(err => logError(SERVICE_NAME, err, 'Kafka Producer Connection'));


// --- API Endpoints ---

// Process Cash Payment (Confirmation from Driver App)
app.post('/payments/cash', async (req, res) => {
    const { rideId, driverId, riderId, amount, currency = 'USD' } = req.body;

    if (!rideId || !driverId || !riderId || amount == null) {
        return res.status(400).json({ message: 'Missing required payment details for cash transaction' });
    }

    console.log(`Processing cash payment confirmation for ride ${rideId}, amount: ${amount} ${currency}`);

    let savedTransaction;
    try {
        // 1. Record the transaction
        const transaction = new Transaction({
            rideId: rideId, // Store as String or ObjectId depending on source
            driverId: driverId,
            riderId: riderId,
            amount,
            currency,
            paymentMethod: 'cash',
            status: 'completed', // Cash payment is confirmed by driver
            gateway: 'cash',
            gatewayTransactionId: `cash_${rideId}_${Date.now()}` // Generate simple ID
        });
        savedTransaction = await transaction.save();
        console.log(`Cash transaction ${savedTransaction._id} recorded for ride ${rideId}`);

        // 2. Publish payment-completed event to Kafka
        await publishPaymentCompleted(rideId, driverId, riderId, {amount, currency});

        res.status(200).json({ message: 'Cash payment confirmed', transaction: savedTransaction });

    } catch (error) {
        logError(SERVICE_NAME, error, `Cash Payment Processing Failed for ride ${rideId}`);
        // Attempt to update transaction status if it was created before failure
         if (savedTransaction && savedTransaction._id) {
            try { await Transaction.findByIdAndUpdate(savedTransaction._id, { status: 'error', errorMessage: 'Failed to publish completion event' }); }
            catch (updateError) { logError(SERVICE_NAME, updateError, `Failed to update transaction status on error for ${savedTransaction._id}`); }
         }
        res.status(500).json({ message: 'Failed to process cash payment confirmation' });
    }
});

// Process In-App Payment (Request from Rider App)
app.post('/payments/in-app', async (req, res) => {
    const { rideId, driverId, riderId, amount, currency = 'USD', paymentMethodId /* from frontend */, customerId /* optional Stripe customer */ } = req.body;

     if (!rideId || !driverId || !riderId || amount == null) { // Removed paymentMethodId requirement for simulation
         return res.status(400).json({ message: 'Missing required payment details for in-app transaction' });
     }
     console.log(`Processing in-app payment request for ride ${rideId}, amount: ${amount} ${currency}`);

     let transactionStatus = 'pending';
     let gatewayId = null;
     let transactionError = null;
     let transaction; // Define transaction here to access in catch blocks

     try {
         // Create initial transaction record
         transaction = new Transaction({
              rideId: rideId,
              driverId: driverId,
              riderId: riderId,
              amount,
              currency,
              paymentMethod: 'in-app',
              status: transactionStatus,
              gateway: 'stripe' // Assume Stripe even for simulation
          });
          await transaction.save();
          console.log(`Pending in-app transaction ${transaction._id} created for ride ${rideId}`);


         // --- Payment Processing ---
         let paymentSucceeded = false;
         let confirmationError = null;

         if (isStripeSimulated || !stripe) {
             // --- Simulation Logic ---
             console.log("Simulating Stripe payment confirmation...");
             await new Promise(resolve => setTimeout(resolve, 1500)); // Simulate network delay
             paymentSucceeded = Math.random() > 0.1; // 90% success rate simulation
             gatewayId = `sim_pi_${rideId}_${Date.now()}`;
             if (!paymentSucceeded) {
                 confirmationError = 'Simulated payment gateway failure.';
             }
             console.log(`Simulation Result for ride ${rideId}: ${paymentSucceeded ? 'Success' : 'Failure'}`);

         } else {
              // --- Real Stripe Logic (Simplified Example) ---
              if (!paymentMethodId) {
                   throw new Error("paymentMethodId is required for actual Stripe payments.");
              }
              try {
                 console.log(`Creating Stripe PaymentIntent for ride ${rideId}...`);
                 const paymentIntent = await stripe.paymentIntents.create({
                      amount: Math.round(amount * 100), // Stripe uses cents
                      currency: currency,
                      payment_method: paymentMethodId,
                      customer: customerId, // Optional
                      confirm: true, // Attempt to confirm immediately
                      // Use off_session if applicable for saved payment methods without user interaction
                      // off_session: true,
                      // confirmation_method: 'automatic', // Default
                       metadata: { rideId, riderId, driverId }, // Store context
                       // Return URL might be needed for 3D Secure
                       // return_url: 'yourapp://payment/complete',
                       automatic_payment_methods: { enabled: true, allow_redirects: 'never' } // Adjust as needed
                  });

                 gatewayId = paymentIntent.id;
                 console.log(`Stripe PaymentIntent ${gatewayId} created for ride ${rideId}. Status: ${paymentIntent.status}`);

                 // Handle different PaymentIntent statuses
                 if (paymentIntent.status === 'succeeded') {
                      paymentSucceeded = true;
                  } else if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'requires_confirmation') {
                      // Needs further action (e.g., 3D Secure) - Front-end usually handles this
                      // For backend-only, this might be treated as pending or failed depending on flow
                      confirmationError = `Payment requires further action (Status: ${paymentIntent.status})`;
                      console.warn(confirmationError);
                      // Don't mark as success yet
                 } else {
                      // Failed or other status
                      confirmationError = `Stripe payment failed (Status: ${paymentIntent.status})`;
                      console.error(confirmationError);
                 }

              } catch (stripeError) {
                 logError(SERVICE_NAME, stripeError, `Stripe API Error for ride ${rideId}`);
                 confirmationError = `Stripe Error: ${stripeError.message}`;
                 paymentSucceeded = false; // Explicitly false on API error
              }
         }

         // --- Update Transaction and Publish Event ---
          if (paymentSucceeded) {
              transactionStatus = 'completed';
              transaction.status = transactionStatus;
              transaction.gatewayTransactionId = gatewayId;
              await transaction.save();
              console.log(`In-app payment successful for ride ${rideId}. Transaction: ${transaction._id}`);
              // Publish event ONLY on success
              await publishPaymentCompleted(rideId, driverId, riderId, { amount, currency });
              res.status(200).json({ message: 'In-app payment successful', transaction });
          } else {
              transactionStatus = 'failed';
              transactionError = confirmationError || 'Payment failed.';
              transaction.status = transactionStatus;
              transaction.gatewayTransactionId = gatewayId;
              transaction.errorMessage = transactionError;
              await transaction.save();
              console.error(`In-app payment failed for ride ${rideId}: ${transactionError}`);
              res.status(400).json({ message: 'In-app payment failed', error: transactionError, transaction });
          }

      } catch (error) {
         logError(SERVICE_NAME, error, `In-app Payment Processing Failed for ride ${rideId}`);
         // Ensure transaction status is updated on unexpected errors
         if (transaction && transaction._id && transaction.status !== 'failed' && transaction.status !== 'completed') {
             try {
                 transaction.status = 'error';
                 transaction.errorMessage = error.message || 'Internal processing error';
                 await transaction.save();
             } catch (saveError) {
                 logError(SERVICE_NAME, saveError, `Failed to save error status to transaction ${transaction._id}`);
             }
         }
         res.status(500).json({ message: 'Failed to process in-app payment' });
     }

});

// Get Transaction Status
app.get('/transactions/:transactionId', async (req, res) => {
    try {
        const transaction = await Transaction.findById(req.params.transactionId);
        if (!transaction) {
            return res.status(404).json({ message: 'Transaction not found' });
        }
        res.json(transaction);
    } catch (error) {
        logError(SERVICE_NAME, error, `GET /transactions/${req.params.transactionId}`);
        res.status(500).json({ message: 'Failed to get transaction status' });
    }
});

// Get Transactions for a Ride
app.get('/rides/:rideId/transactions', async (req, res) => {
    try {
        const transactions = await Transaction.find({ rideId: req.params.rideId }).sort({ createdAt: -1 });
        res.json(transactions);
    } catch (error) {
        logError(SERVICE_NAME, error, `GET /rides/${req.params.rideId}/transactions`);
        res.status(500).json({ message: 'Failed to get transactions' });
    }
});


// --- Kafka Publishing Helper ---
async function publishPaymentCompleted(rideId, driverId, riderId, fare) {
    const producer = getKafkaProducer();
    if (!producer) {
        logError(SERVICE_NAME, new Error("Kafka Producer not available"), `Cannot publish payment-completed event for ${rideId}`);
        console.warn(`Kafka Producer not connected. Cannot publish payment-completed event for ${rideId}. Ride/Driver status may not update.`);
        // CRITICAL: Consider alternative notification or retry mechanism here.
        return;
    }
    try {
        const payload = JSON.stringify({
             rideId,
             driverId,
             riderId,
             status: 'completed', // Event signifies completion
             fare, // Include fare details
             timestamp: new Date().toISOString() // Add event timestamp
        });
        await producer.send({
            topic: 'payment-completed',
            messages: [{ key: rideId, value: payload }],
        });
        console.log(`Published payment-completed event for ride ${rideId}`);
    } catch (error) {
        logError(SERVICE_NAME, error, `Kafka Publish payment-completed Failed for ${rideId}`);
        console.error(`Failed to publish payment-completed event for ride ${rideId}:`, error);
        // Handle Kafka publish failure (retry? alert?)
    }
}

// --- Health Check ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'UP',
        mongo: mongoose.connection.readyState === 1,
        kafkaProducer: isKafkaProducerConnected
     });
});

// --- Server Start ---
const PORT = process.env.PAYMENT_SERVICE_PORT || 3004;
app.listen(PORT, () => {
    console.log(`Payment Service listening on port ${PORT}`);
});

// Graceful shutdown for Kafka
process.on('SIGINT', async () => {
  await disconnectKafka();
  process.exit(0);
});
process.on('SIGTERM', async () => {
    await disconnectKafka();
    process.exit(0);
});

// Basic Error Handling Middleware
app.use((err, req, res, next) => {
  logError(SERVICE_NAME, err, 'Unhandled Route Error');
  console.error(err.stack);
  res.status(500).send('Something broke!');
});
