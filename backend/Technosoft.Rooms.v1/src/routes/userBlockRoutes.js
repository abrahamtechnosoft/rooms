const router = require("express").Router();
const authMiddleware = require("../middlewares/authMiddleware");
const ctrl = require("../controllers/userBlockController");

router.use(authMiddleware);

router.get("/", ctrl.listMyBlocks);
router.post("/", ctrl.createMyBlock);
router.patch("/:id", ctrl.updateMyBlock);
router.delete("/:id", ctrl.deleteMyBlock);

module.exports = router;
