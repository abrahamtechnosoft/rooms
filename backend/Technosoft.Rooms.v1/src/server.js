require('dotenv').config();
const app = require('./app');
const { getPool } = require('./config/db');
const { startUsageConfirmationJob } = require('./jobs/usageConfirmationJob');
const { startReminderJob } = require('./jobs/reminderJob');
const { startNotificationCleanupJob } = require('./jobs/notificationCleanupJob');

const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await getPool();
  } catch (e) {
    console.warn('[Server] Arrancando sin conexion a DB. Revisar .env');
  }

  app.listen(PORT, () => {
    console.log(`[Server] Technosoft.Rooms.v1 escuchando en http://localhost:${PORT}`);
  });

  // Jobs en background — solo escriben en DB y envían correos, no necesitan
  // estar bloqueando el arranque del HTTP server.
  startUsageConfirmationJob();
  startReminderJob();
  startNotificationCleanupJob();
})();
