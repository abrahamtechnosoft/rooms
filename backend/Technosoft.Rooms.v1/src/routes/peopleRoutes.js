const router = require('express').Router();
const ctrl = require('../controllers/peopleController');
const authMiddleware = require('../middlewares/authMiddleware');

router.get('/', authMiddleware, ctrl.listPeople);
router.get('/:id', authMiddleware, ctrl.getPerson);

module.exports = router;
