const router = require("express").Router();
const ctrl = require("../controllers/reminderController");
const authMiddleware = require("../middlewares/authMiddleware");

router.use(authMiddleware);

router.get("/", ctrl.getReminders);
router.post("/", ctrl.createReminder);
router.put("/:id", ctrl.updateReminder);
router.delete("/:id", ctrl.deleteReminder);
router.post("/:id/notified", ctrl.markNotified);

module.exports = router;
