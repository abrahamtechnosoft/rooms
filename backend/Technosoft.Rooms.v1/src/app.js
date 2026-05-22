const path = require("path");
const express = require("express");
const cors = require("cors");
const { err } = require("./utils/reply");

const authRoutes = require("./routes/authRoutes");
const roomRoutes = require("./routes/roomRoutes");
const reservationRoutes = require("./routes/reservationRoutes");
const userRoutes = require("./routes/userRoutes");
const peopleRoutes = require("./routes/peopleRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const adminRoutes = require("./routes/adminRoutes");
const departmentRoutes = require("./routes/departmentRoutes");
const healthRoutes = require("./routes/healthRoutes");
const userBlockRoutes = require("./routes/userBlockRoutes");
const recurringSeriesRoutes = require("./routes/recurringSeriesRoutes");
const noteRoutes = require("./routes/noteRoutes");
const reminderRoutes = require("./routes/reminderRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
    credentials: false,
  })
);
app.use(express.json({ limit: "2mb" }));

app.use(
  "/uploads",
  express.static(path.join(__dirname, "..", "uploads"))
);

app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/rooms", roomRoutes);
app.use("/api/reservations", reservationRoutes);
app.use("/api/users", userRoutes);
app.use("/api/people", peopleRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/departments", departmentRoutes);
app.use("/api/users/me/blocks", userBlockRoutes);
app.use("/api/recurring-series", recurringSeriesRoutes);
app.use("/api/notes", noteRoutes);
app.use("/api/reminders", reminderRoutes);
app.use("/api/dashboard", dashboardRoutes);

app.use((req, res) => {
  res.status(404).json(err("Recurso no encontrado"));
});

// eslint-disable-next-line no-unused-vars
app.use((e, req, res, _next) => {
  res.status(500).json(err("Operacion fallida"));
});

module.exports = app;
