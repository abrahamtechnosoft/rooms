const { getPool } = require('../config/db');

const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // cada 24 horas
const FIRST_DELAY_MS = 60 * 1000; // primera corrida al minuto

async function cleanupNotifications() {
  try {
    const pool = await getPool();

    const r1 = await pool.request().query(`
      DELETE FROM core.notifications
      WHERE is_read = 1
        AND read_at IS NOT NULL
        AND read_at < DATEADD(DAY, -7, SYSDATETIME())
    `);

    const r2 = await pool.request().query(`
      DELETE n
      FROM core.notifications n
      JOIN core.reservations r ON r.reservation_id = n.reservation_id
      WHERE r.ends_at < DATEADD(DAY, -7, SYSDATETIME())
    `);

    const readDeleted = r1.rowsAffected && r1.rowsAffected[0] ? r1.rowsAffected[0] : 0;
    const pastDeleted = r2.rowsAffected && r2.rowsAffected[0] ? r2.rowsAffected[0] : 0;
    console.log(
      `[notifCleanup] eliminadas ${readDeleted} leídas (>7d) + ${pastDeleted} de reuniones pasadas (>7d)`
    );
  } catch (e) {
    console.error('[notifCleanup]', e.message);
  }
}

function startNotificationCleanupJob() {
  setTimeout(cleanupNotifications, FIRST_DELAY_MS);
  setInterval(cleanupNotifications, RUN_INTERVAL_MS);
  console.log('[notifCleanupJob] iniciado, corre cada 24h');
}

module.exports = { startNotificationCleanupJob, cleanupNotifications };
