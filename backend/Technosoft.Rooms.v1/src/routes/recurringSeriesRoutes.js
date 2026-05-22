const router = require("express").Router();
const ctrl = require("../controllers/recurringSeriesController");
const authMiddleware = require("../middlewares/authMiddleware");

router.use(authMiddleware);

router.post("/", ctrl.createSeries);
router.get("/:id", ctrl.getSeries);
router.get("/:id/instances", ctrl.listInstances);
router.patch(
  "/:id/from-instance/:reservationId",
  ctrl.editSeriesFromInstance
);
router.delete("/:id", ctrl.cancelSeries);
router.post("/:id/delete-permanent", ctrl.deleteSeries);

module.exports = router;
