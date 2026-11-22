const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const config = require('./config');
const routes = require('./routes');
const { verifyWebhook, markPaid, markFailed } = require('./services/paymentService');
const { Payment } = require('./models');
const { notFound, errorHandler } = require('./middleware/error');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: config.clientUrl.split(',').map((s) => s.trim()), credentials: true }));
if (config.env !== 'test') app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));

// Razorpay webhook needs the raw body for signature verification — register before express.json().
app.post('/api/payments/razorpay/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!verifyWebhook(req.body, req.get('x-razorpay-signature'))) return res.status(400).json({ success: false });
  const event = JSON.parse(req.body.toString());
  const entity = event.payload?.payment?.entity;
  if (entity?.order_id) {
    const payment = await Payment.findOne({ razorpayOrderId: entity.order_id });
    if (payment && event.event === 'payment.captured') await markPaid(payment, { razorpayPaymentId: entity.id });
    if (payment && event.event === 'payment.failed') await markFailed(payment, entity.error_description);
  }
  return res.json({ success: true });
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Public bus photos only. Verification documents are served through authenticated endpoints.
app.use('/uploads/images', express.static(path.join(config.uploads.dir, 'images'), { maxAge: '7d' }));

app.use('/api', routes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
