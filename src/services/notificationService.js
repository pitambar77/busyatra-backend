const { Notification } = require('../models');

async function notifyOwner(ownerId, type, title, message, link) {
  if (!ownerId) return null;
  return Notification.create({ owner: ownerId, audience: 'owner', type, title, message, link });
}

async function notifyAdmin(type, title, message, link) {
  return Notification.create({ audience: 'admin', type, title, message, link });
}

module.exports = { notifyOwner, notifyAdmin };
