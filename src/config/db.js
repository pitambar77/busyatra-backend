const mongoose = require('mongoose');
const config = require('./index');

mongoose.set('strictQuery', true);

async function connectDB(uri = config.mongoUri) {
  await mongoose.connect(uri);
  if (config.env !== 'test') console.log(`MongoDB connected: ${mongoose.connection.host}/${mongoose.connection.name}`);
  return mongoose.connection;
}

module.exports = { connectDB };
