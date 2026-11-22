require('dotenv').config({ quiet: true });

const env = (key, fallback) => (process.env[key] !== undefined && process.env[key] !== '' ? process.env[key] : fallback);

const config = {
  env: env('NODE_ENV', 'development'),
  // 5000 is avoided: macOS uses it for AirPlay Receiver.
  port: Number(env('PORT', 5050)),
  mongoUri: env('MONGODB_URI', 'mongodb://127.0.0.1:27017/busyatra'),
  clientUrl: env('CLIENT_URL', 'http://localhost:3000,http://localhost:3001'),
  publicApiUrl: env('PUBLIC_API_URL', 'http://localhost:5050'),
  jwt: {
    secret: env('JWT_SECRET', 'change-this-dev-secret'),
    expiresIn: env('JWT_EXPIRES_IN', '7d'),
  },
  timezone: env('APP_TIMEZONE', 'Asia/Kolkata'),
  otp: {
    ttlMinutes: Number(env('OTP_TTL_MINUTES', 10)),
    // In development the OTP is returned in the API response so the flow can be tested without an SMS provider.
    exposeInResponse: env('OTP_EXPOSE_IN_RESPONSE', env('NODE_ENV', 'development') !== 'production' ? 'true' : 'false') === 'true',
    smsProvider: env('SMS_PROVIDER', 'console'), // console | msg91 | twilio (plug in your provider in utils/sms.js)
  },
  razorpay: {
    keyId: env('RAZORPAY_KEY_ID', ''),
    keySecret: env('RAZORPAY_KEY_SECRET', ''),
    webhookSecret: env('RAZORPAY_WEBHOOK_SECRET', ''),
  },
  uploads: {
    dir: env('UPLOAD_DIR', require('path').join(__dirname, '..', '..', 'uploads')),
    maxFileSizeMb: Number(env('UPLOAD_MAX_MB', 5)),
  },
  company: {
    name: env('COMPANY_NAME', 'BusYatra'),
    address: env('COMPANY_ADDRESS', 'Bhubaneswar, Odisha, India'),
    gstin: env('COMPANY_GSTIN', ''),
    supportEmail: env('SUPPORT_EMAIL', 'support@busyatra.in'),
  },
  expiryReminderDays: Number(env('EXPIRY_REMINDER_DAYS', 3)),
};

// Payments run in "mock" mode when Razorpay keys are not configured, so the full flow can be demoed locally.
config.razorpay.mode = config.razorpay.keyId && config.razorpay.keySecret ? 'live' : 'mock';

if (config.env === 'production' && config.jwt.secret === 'change-this-dev-secret') {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = config;
