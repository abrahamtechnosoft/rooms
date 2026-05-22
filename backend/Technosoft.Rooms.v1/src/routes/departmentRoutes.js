const router = require("express").Router();
const ctrl = require("../controllers/departmentController");
const authMiddleware = require("../middlewares/authMiddleware");

router.use(authMiddleware);

router.get("/", ctrl.listDepartments);
router.post("/", ctrl.createDepartment);
router.patch("/:id", ctrl.updateDepartment);
router.get("/:id/members", ctrl.getDepartmentMembers);

module.exports = router;
