const router = require('express').Router();
const auth = require('../controllers/authController');
const authMiddleware = require('../middlewares/authMiddleware');

router.post('/request-code', auth.requestCode);
router.post('/verify-code', auth.verifyCode);
router.get('/me', authMiddleware, auth.me);
router.put('/me', authMiddleware, auth.updateMe);

module.exports = router;
