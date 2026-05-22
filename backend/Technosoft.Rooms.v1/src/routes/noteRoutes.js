const router = require("express").Router();
const ctrl = require("../controllers/noteController");
const authMiddleware = require("../middlewares/authMiddleware");

router.use(authMiddleware);

router.get("/", ctrl.getNotes);
router.post("/", ctrl.createNote);
router.put("/:id", ctrl.updateNote);
router.delete("/:id", ctrl.deleteNote);
router.post("/:id/pin", ctrl.togglePinned);

module.exports = router;
