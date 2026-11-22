const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { ApiError } = require('../utils/helpers');

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DOC_TYPES = [...IMAGE_TYPES, 'application/pdf'];

function storageFor(sub) {
  const dir = path.join(config.uploads.dir, sub);
  fs.mkdirSync(dir, { recursive: true });
  return multer.diskStorage({
    destination: dir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '';
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    },
  });
}

function filter(allowed) {
  return (req, file, cb) => {
    if (allowed.includes(file.mimetype)) return cb(null, true);
    cb(new ApiError(400, `Unsupported file type: ${file.mimetype}`));
  };
}

const limits = { fileSize: config.uploads.maxFileSizeMb * 1024 * 1024 };

// Bus photos are public (served from /uploads/images).
const uploadImages = multer({ storage: storageFor('images'), fileFilter: filter(IMAGE_TYPES), limits });
// Verification documents are private (served only through the authenticated admin/owner endpoint).
const uploadDocs = multer({ storage: storageFor('docs'), fileFilter: filter(DOC_TYPES), limits });

const imageUrl = (filename) => `/uploads/images/${filename}`;

function removeUploadedImage(url) {
  if (!url || !url.startsWith('/uploads/images/')) return;
  const p = path.join(config.uploads.dir, 'images', path.basename(url));
  fs.promises.unlink(p).catch(() => {});
}

module.exports = { uploadImages, uploadDocs, imageUrl, removeUploadedImage };
