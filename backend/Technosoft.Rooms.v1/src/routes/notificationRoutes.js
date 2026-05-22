const router = require('express').Router();
const ctrl = require('../controllers/notificationController');
const authMiddleware = require('../middlewares/authMiddleware');

router.use(authMiddleware);

router.get('/unread-count', ctrl.unreadCount);
router.get('/', ctrl.listMine);
router.patch('/read-all', ctrl.markAllRead);
router.patch('/by-reservation/:reservationId/read', ctrl.markByReservation);
router.patch('/:id/read', ctrl.markOneRead);

module.exports = router;
