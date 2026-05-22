const express = require("express");
const authMiddleware = require("../middlewares/authMiddleware");
const {
  getByDateRange,
  getMine,
  getVirtual,
  getExternal,
  getWeek,
  getById,
  getParticipants,
  getHistory,
  listHistory,
  create,
  update,
  cancel,
  leaveReservation,
  getAttendance,
  setAttendance,
  getNotes,
  createNote,
  updateNote,
  deleteNote,
  getNoteEdits,
  getExternalGuests,
  addExternalGuest,
  removeExternalGuest,
  endEarly,
  createQuick,
  checkConflict,
  confirmUsage,
  getPendingConfirmation,
  checkBlocks,
  respondInvitation,
  getMyRequests,
} = require("../controllers/reservationController");
const {
  listAttachments,
  addAttachment,
  deleteAttachment,
} = require("../controllers/attachmentController");
const {
  getSummary,
  addSummaryItem,
} = require("../controllers/summaryController");

const router = express.Router();

router.use(authMiddleware);

router.get("/", getByDateRange);
router.get("/mine", getMine);
router.get("/virtual", getVirtual);
router.get("/external", getExternal);
router.get("/week", getWeek);
router.get("/history", listHistory);

// Reservar ahora (G2)
router.post("/quick", createQuick);

// Confirmación de uso (reuniones fantasma sin asistencia).
router.get("/pending-confirmation", getPendingConfirmation);
router.post("/:id/confirm-usage", confirmUsage);

// Chequeo de conflicto debounced desde el form (TimeRangeInput)
router.get("/check-conflict", checkConflict);

// Bloqueos personales — previsualizar y responder peticiones
router.post("/check-blocks", checkBlocks);
router.get("/my-requests", getMyRequests);
router.post("/:id/invitation-response", respondInvitation);
router.get("/:id/participants", getParticipants);
router.get("/:id/history", getHistory);

// Asistencia (G2)
router.get("/:id/attendance", getAttendance);
router.post("/:id/attendance", setAttendance);

// Notas (G3) — ahora con hilos + historial de ediciones
router.get("/:id/notes", getNotes);
router.post("/:id/notes", createNote);
router.patch("/:id/notes/:noteId", updateNote);
router.delete("/:id/notes/:noteId", deleteNote);
router.get("/:id/notes/:noteId/edits", getNoteEdits);

// Resumen colaborativo (append-only)
router.get("/:id/summary", getSummary);
router.post("/:id/summary", addSummaryItem);

// Invitados externos (G5)
router.get("/:id/external-guests", getExternalGuests);
router.post("/:id/external-guests", addExternalGuest);
router.delete("/:id/external-guests/:guestId", removeExternalGuest);

// Archivos adjuntos por URL
router.get("/:id/attachments", listAttachments);
router.post("/:id/attachments", addAttachment);
router.delete("/:id/attachments/:attachmentId", deleteAttachment);

// Terminar antes (G1)
router.post("/:id/end-early", endEarly);

router.get("/:id", getById);
router.post("/", create);
router.put("/:id", update);
router.delete("/:id", cancel);
router.post("/:id/leave", leaveReservation);

module.exports = router;
