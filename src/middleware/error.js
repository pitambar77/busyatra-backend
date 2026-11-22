const multer = require('multer');
const config = require('../config');
const { ApiError } = require('../utils/helpers');

function notFound(req, res) {
  res.status(404).json({ success: false, message: `Not found: ${req.method} ${req.originalUrl}` });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  let status = err.status || 500;
  let message = err.message || 'Something went wrong';
  let details = err.details;

  if (err.name === 'ValidationError') {
    status = 400;
    details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    message = details[0]?.message || 'Validation failed';
  } else if (err.name === 'CastError') {
    status = 400;
    message = `Invalid ${err.path}`;
  } else if (err.code === 11000) {
    status = 409;
    const field = Object.keys(err.keyPattern || err.keyValue || {})[0] || 'value';
    message = `${field === 'registrationNumber' ? 'Registration number' : field} already exists`;
  } else if (err instanceof multer.MulterError) {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? `File too large (max ${config.uploads.maxFileSizeMb} MB)` : err.message;
  } else if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON body';
  }

  if (status >= 500 && config.env !== 'test') console.error(err);
  if (!(err instanceof ApiError) && status >= 500 && config.env === 'production') message = 'Internal server error';

  res.status(status).json({ success: false, message, ...(details ? { details } : {}) });
}

module.exports = { notFound, errorHandler };
