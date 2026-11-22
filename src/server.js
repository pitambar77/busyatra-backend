const config = require('./config');
const { connectDB } = require('./config/db');
const app = require('./app');
const { startScheduler } = require('./jobs/scheduler');

(async () => {
  await connectDB();
  startScheduler();
  app.listen(config.port, () => {
    console.log(`API listening on http://localhost:${config.port} (payments: ${config.razorpay.mode} mode)`);
  });
})().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
