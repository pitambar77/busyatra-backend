const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../controllers/authController');
const pub = require('../controllers/publicController');
const owner = require('../controllers/ownerController');
const admin = require('../controllers/adminController');
const { optionalAuth, requireAuth, requireOwnerAccess, requireOwnerOnly, requireAdmin } = require('../middleware/auth');
const { uploadImages, uploadDocs } = require('../middleware/upload');
const config = require('../config');

const router = express.Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.env === 'production' ? 30 : 1000, standardHeaders: true, legacyHeaders: false, message: { success: false, message: 'Too many attempts, please try again later' } });
const trackLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

router.get('/health', (req, res) => res.json({ success: true, status: 'ok', paymentMode: config.razorpay.mode, time: new Date().toISOString() }));

// ── Auth ──
router.post('/auth/register', authLimiter, auth.register);
router.post('/auth/register-owner', authLimiter, uploadDocs.array('documents', 5), auth.registerOwner);
router.post('/auth/send-otp', authLimiter, auth.sendOtp);
router.post('/auth/verify-otp', authLimiter, auth.verifyOtp);
router.post('/auth/login', authLimiter, auth.login);
router.post('/auth/reset-password', authLimiter, auth.resetPassword);
router.get('/auth/me', requireAuth, auth.me);
router.post('/auth/change-password', requireAuth, auth.changePassword);
router.post('/admin/auth/login', authLimiter, auth.adminLogin);

// ── Public ──
router.get('/public/meta', pub.meta);
router.get('/public/home', pub.home);
router.get('/public/cities', pub.cities);
router.get('/public/cities/:city/stops', pub.cityStops);
router.get('/public/search', pub.search);
router.get('/public/routes', pub.routesIndex);
router.get('/public/routes/:from/:to', pub.routeTimetable);
router.get('/public/buses/:id', pub.busDetails);
router.get('/public/operators', pub.operators);
router.get('/public/operators/:slug', pub.operatorDetails);
router.get('/public/plans', pub.plans);
router.post('/public/track', trackLimiter, optionalAuth, pub.track);
router.post('/public/enquiries', trackLimiter, optionalAuth, pub.createEnquiry);
router.post('/public/contact', trackLimiter, pub.contact);

// ── Owner / operator dashboard ──
const o = express.Router();
o.get('/dashboard', requireOwnerAccess(), owner.dashboard);
o.get('/lookups', requireOwnerAccess(), owner.lookups);
o.get('/profile', requireOwnerAccess(), owner.getProfile);
o.put('/profile', requireOwnerOnly, owner.updateProfile);
o.post('/profile/documents', requireOwnerOnly, uploadDocs.array('documents', 5), owner.uploadDocuments);
o.delete('/profile/documents/:docId', requireOwnerOnly, owner.deleteDocument);
o.get('/profile/documents/:docId', requireOwnerOnly, owner.downloadDocument);

o.get('/buses', requireOwnerAccess(), owner.listBuses);
o.post('/buses', requireOwnerAccess('manageBuses'), uploadImages.array('images', 10), owner.createBus);
o.get('/buses/:id', requireOwnerAccess(), owner.getBus);
o.put('/buses/:id', requireOwnerAccess('manageBuses'), owner.updateBus);
o.delete('/buses/:id', requireOwnerAccess('manageBuses'), owner.deleteBus);
o.patch('/buses/:id/active', requireOwnerAccess('manageBuses'), owner.setBusActive);
o.post('/buses/:id/images', requireOwnerAccess('manageBuses'), uploadImages.array('images', 10), owner.addBusImages);
o.delete('/buses/:id/images', requireOwnerAccess('manageBuses'), owner.removeBusImage);
o.put('/buses/:id/images/order', requireOwnerAccess('manageBuses'), owner.reorderBusImages);
o.post('/buses/:id/submit', requireOwnerAccess('manageBuses'), owner.submitBus);
o.put('/buses/:id/suspension', requireOwnerAccess('updateStatus'), owner.setSuspension);

o.get('/routes', requireOwnerAccess(), owner.listRoutes);
o.post('/routes', requireOwnerAccess('manageRoutes'), owner.createRoute);
o.get('/routes/:id', requireOwnerAccess(), owner.getRoute);
o.put('/routes/:id', requireOwnerAccess('manageRoutes'), owner.updateRoute);
o.delete('/routes/:id', requireOwnerAccess('manageRoutes'), owner.deleteRoute);

o.get('/status', requireOwnerAccess('updateStatus'), owner.statusBoard);
o.post('/status/bulk', requireOwnerAccess('updateStatus'), owner.bulkUpdateStatus);
o.put('/status/:busId', requireOwnerAccess('updateStatus'), owner.updateStatus);
o.get('/status/:busId/history', requireOwnerAccess(), owner.statusHistory);

o.get('/team', requireOwnerAccess('manageTeam'), owner.listTeam);
o.post('/team', requireOwnerAccess('manageTeam'), owner.addTeamMember);
o.put('/team/:id', requireOwnerAccess('manageTeam'), owner.updateTeamMember);
o.delete('/team/:id', requireOwnerAccess('manageTeam'), owner.removeTeamMember);

o.get('/plans', requireOwnerAccess(), owner.plans);
o.get('/subscriptions', requireOwnerAccess('viewPayments'), owner.listSubscriptions);
o.post('/subscriptions/checkout', requireOwnerAccess('managePayments'), owner.checkout);
o.post('/payments/verify', requireOwnerAccess('managePayments'), owner.verifyPayment);
o.post('/payments/:id/mock-complete', requireOwnerAccess('managePayments'), owner.mockComplete);
o.post('/payments/:id/failed', requireOwnerAccess('managePayments'), owner.reportFailure);
o.get('/payments', requireOwnerAccess('viewPayments'), owner.listPayments);
o.get('/payments/:id/receipt', requireOwnerAccess('viewPayments'), owner.receipt);

o.get('/enquiries', requireOwnerAccess(), owner.listEnquiries);
o.patch('/enquiries/:id', requireOwnerAccess(), owner.updateEnquiry);
o.get('/notifications', requireOwnerAccess(), owner.notifications);
o.patch('/notifications/read-all', requireOwnerAccess(), owner.readNotifications);
router.use('/owner', o);

// ── Super admin ──
const a = express.Router();
const any = requireAdmin();
const superOnly = requireAdmin('super_admin');
const editors = requireAdmin('super_admin', 'admin');
a.get('/dashboard', any, admin.dashboard);
a.get('/owners', any, admin.listOwners);
a.get('/owners/:id', any, admin.getOwner);
a.put('/owners/:id', editors, admin.updateOwner);
a.patch('/owners/:id/verify', any, admin.verifyOwner);
a.patch('/owners/:id/suspend', editors, admin.suspendOwner);
a.get('/owners/:id/documents/:docId', any, admin.downloadDocument);
a.patch('/owners/:id/documents/:docId', any, admin.verifyDocument);

a.get('/buses', any, admin.listBuses);
a.get('/buses/:id', any, admin.getBus);
a.put('/buses/:id', editors, admin.updateBus);
a.patch('/buses/:id/review', any, admin.reviewBus);
a.patch('/buses/:id/disable', any, admin.disableBus);
a.delete('/buses/:id', editors, admin.removeBus);
a.put('/buses/:id/status', editors, admin.setBusStatus);
a.get('/status', any, admin.statusBoard);

a.get('/plans', any, admin.listPlans);
a.post('/plans', superOnly, admin.createPlan);
a.put('/plans/:id', superOnly, admin.updatePlan);
a.delete('/plans/:id', superOnly, admin.deletePlan);
a.get('/subscriptions', any, admin.listSubscriptions);
a.post('/subscriptions/grant', editors, admin.grantSubscription);
a.patch('/subscriptions/:id/extend', editors, admin.extendSubscription);
a.patch('/subscriptions/:id/cancel', editors, admin.cancelSubscription);
a.get('/payments', any, admin.listPayments);
a.post('/payments/:id/refund', superOnly, admin.refund);
a.post('/payments/:id/mark-paid', superOnly, admin.markPaymentPaid);
a.get('/payments/:id/receipt', any, admin.receipt);

a.get('/cities', any, admin.listCities);
a.post('/cities', editors, admin.createCity);
a.put('/cities/:id', editors, admin.updateCity);
a.post('/cities/:id/image', editors, uploadImages.single('image'), admin.uploadCityImage);
a.delete('/cities/:id', editors, admin.deleteCity);
a.get('/stops', any, admin.listStops);
a.post('/stops', editors, admin.createStop);
a.put('/stops/:id', editors, admin.updateStop);
a.delete('/stops/:id', editors, admin.deleteStop);
a.get('/categories', any, admin.listCategories);
a.post('/categories', editors, admin.createCategory);
a.put('/categories/:id', editors, admin.updateCategory);
a.delete('/categories/:id', editors, admin.deleteCategory);
a.get('/popular-routes', any, admin.listPopularRoutes);
a.post('/popular-routes', editors, admin.createPopularRoute);
a.put('/popular-routes/:id', editors, admin.updatePopularRoute);
a.delete('/popular-routes/:id', editors, admin.deletePopularRoute);

a.get('/hero', any, admin.getHero);
a.put('/hero/settings', editors, admin.updateHeroSettings);
a.post('/hero/slides', editors, admin.createHeroSlide);
a.put('/hero/slides/order', editors, admin.reorderHeroSlides);
a.put('/hero/slides/:id', editors, admin.updateHeroSlide);
a.delete('/hero/slides/:id', editors, admin.deleteHeroSlide);
a.post('/uploads/image', editors, uploadImages.single('image'), admin.uploadImage);

a.get('/enquiries', any, admin.listEnquiries);
a.patch('/enquiries/:id', any, admin.updateEnquiry);
a.get('/reports', any, admin.reports);
a.get('/admins', superOnly, admin.listAdmins);
a.post('/admins', superOnly, admin.createAdmin);
a.put('/admins/:id', superOnly, admin.updateAdmin);
a.get('/notifications', any, admin.notifications);
a.patch('/notifications/read-all', any, admin.readNotifications);
a.post('/jobs/run', superOnly, admin.runJobs);
router.use('/admin', a);

module.exports = router;
