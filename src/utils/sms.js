const config = require('../config');

/**
 * SMS delivery for OTPs. The default "console" provider logs the message so OTP
 * verification can be tested locally. To go live, implement your provider
 * (MSG91, Twilio, Gupshup, etc.) in the switch below and set SMS_PROVIDER.
 */
async function sendSms(mobile, message) {
  switch (config.otp.smsProvider) {
    case 'console':
    default:
      if (config.env !== 'test') console.log(`[SMS → ${mobile}] ${message}`);
      return { delivered: true, provider: 'console' };
  }
}

module.exports = { sendSms };
