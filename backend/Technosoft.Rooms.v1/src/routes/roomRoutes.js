const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const { requireRole } = require("../middlewares/roleMiddleware");
const {
  getAll,
  getById,
  create,
  update,
  softDelete,
  getAvailability,
} = require("../controllers/roomController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", getAll);
router.get("/:id/availability", getAvailability);
router.get("/:id", getById);
router.post("/", requireRole("admin"), create);
router.put("/:id", requireRole("admin"), update);
router.delete("/:id", requireRole("admin"), softDelete);

module.exports = router;
