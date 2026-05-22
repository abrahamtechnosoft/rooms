const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  getEvents,
  getSummary,
} = require("../controllers/adminReportsController");

const router = express.Router();

router.use(authMiddleware);

router.get("/reports/events", getEvents);
router.get("/reports/summary", getSummary);

module.exports = router;
