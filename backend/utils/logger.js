const fs = require('fs');
const path = require('path');

const logDirectory = path.join(__dirname, '../logs'); // Log directory relative to backend root

// Ensure log directory exists
if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory);
}

const logError = (serviceName, error, context = '') => {
    const timestamp = new Date().toISOString();
    const logFilePath = path.join(logDirectory, `${serviceName}-error.log`);

    let errorMessage = `${timestamp} [${serviceName.toUpperCase()}] ${context ? `(${context})` : ''}:\n`;

    if (error instanceof Error) {
        errorMessage += `Error: ${error.message}\nStack: ${error.stack}\n`;
    } else if (typeof error === 'object' && error !== null) {
        errorMessage += `Error Object: ${JSON.stringify(error, null, 2)}\n`;
    } else {
        errorMessage += `Error: ${String(error)}\n`;
    }
    errorMessage += '-'.repeat(50) + '\n';


    fs.appendFile(logFilePath, errorMessage, (err) => {
        if (err) {
            console.error(`Failed to write to log file ${logFilePath}:`, err);
        }
    });

    // Also log to console for immediate visibility during development
    console.error(errorMessage);
};

module.exports = { logError };
