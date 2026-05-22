const router = require("express").Router();
const ctrl = require("../controllers/dashboardController");
const authMiddleware = require("../middlewares/authMiddleware");

router.use(authMiddleware);

router.get("/layout", ctrl.getLayout);
router.put("/layout", ctrl.saveLayout);

module.exports = router;
