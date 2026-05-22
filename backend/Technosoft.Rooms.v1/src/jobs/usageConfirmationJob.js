const { getPool, sql } = require("../config/db");
const { sendUsageConfirmationEmail } = require("../services/mailer");
const { createNotification } = require("../utils/createNotification");

const RUN_INTERVAL_MS = 5 * 60 * 1000; // cada 5 minutos
const FIRST_DELAY_MS = 30 * 1000; // primera corrida a los 30s

function fmtHora(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Solicita confirmación de uso a reuniones físicas que llevan >=15 minutos
 * iniciadas, siguen en curso y nadie marcó asistencia. Solo se solicita una
 * vez por reunión (la columna `usage_confirmation_requested_at` se llena al
 * enviar el correo, lo que evita reenvíos).
 */
async function checkPendingConfirmations() {
  let pool;
  try {
    pool = await getPool();
  } catch (e) {
    console.error("[usageConfirmationJob] No pool", e.message);
    return;
  }

  let candidates;
  try {
    const result = await pool.request().query(`
      SELECT
        r.reservation_id,
        r.title,
        r.starts_at,
        r.ends_at,
        r.created_by,
        u.full_name AS organizer_name,
        u.email     AS organizer_email,
        ro.name     AS room_name
      FROM core.reservations r
      JOIN auth.users u ON u.user_id = r.created_by
      LEFT JOIN core.rooms ro ON ro.room_id = r.room_id
      WHERE r.reservation_type = 'physical'
        AND r.status = 'active'
        AND r.usage_confirmed = 0
        AND r.usage_confirmation_requested_at IS NULL
        AND r.starts_at <= DATEADD(MINUTE, -15, SYSDATETIME())
        AND r.ends_at > SYSDATETIME()
        AND NOT EXISTS (
          SELECT 1 FROM core.reservation_attendance a
          WHERE a.reservation_id = r.reservation_id
        );
    `);
    candidates = result.recordset;
  } catch (e) {
    console.error("[usageConfirmationJob] Query fallo", e.message);
    return;
  }

  for (const row of candidates) {
    try {
      if (row.organizer_email) {
        await sendUsageConfirmationEmail({
          to: row.organizer_email,
          organizerName: row.organizer_name || row.organizer_email,
          title: row.title,
          roomName: row.room_name || "Sala",
          startsAt: row.starts_at,
          endsAt: row.ends_at,
        });
      }

      await createNotification({
        userId: row.created_by,
        reservationId: row.reservation_id,
        type: "usage_confirmation_requested",
        title: `Confirma el uso de "${row.title}"`,
        body: `Nadie marcó asistencia. Por favor confirma si la reunión está en curso.`,
      });

      await pool
        .request()
        .input("rId", sql.Int, row.reservation_id)
        .query(`
          UPDATE core.reservations
          SET usage_confirmation_requested_at = SYSDATETIME()
          WHERE reservation_id = @rId
        `);

      console.log(
        `[usageConfirmationJob] Solicitud enviada para reserva ${row.reservation_id} (${fmtHora(row.starts_at)})`
      );
    } catch (e) {
      console.error(
        `[usageConfirmationJob] Falla en reserva ${row.reservation_id}:`,
        e.message
      );
    }
  }
}

function startUsageConfirmationJob() {
  setTimeout(() => {
    checkPendingConfirmations().catch((e) =>
      console.error("[usageConfirmationJob] primera corrida", e.message)
    );
  }, FIRST_DELAY_MS);
  setInterval(() => {
    checkPendingConfirmations().catch((e) =>
      console.error("[usageConfirmationJob] corrida periódica", e.message)
    );
  }, RUN_INTERVAL_MS);
  console.log("[usageConfirmationJob] iniciado, cada 5 min");
}

module.exports = { startUsageConfirmationJob, checkPendingConfirmations };
