const { getPool, sql } = require("../config/db");
const { sendReminderEmail } = require("../services/mailer");
const { createNotification } = require("../utils/createNotification");

const RUN_INTERVAL_MS = 5 * 60 * 1000; // cada 5 minutos
const FIRST_DELAY_MS = 60 * 1000; // primera corrida al minuto

function fmtHora(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Query base: organizador + participantes activos.
// Filtros (ventana de tiempo + bandera) se inyectan por parámetro.
function buildReminderQuery({ flagColumn, minutesAheadMin, minutesAheadMax }) {
  return `
    SELECT DISTINCT
      r.reservation_id,
      r.title,
      r.starts_at,
      r.ends_at,
      r.reservation_type,
      r.meeting_link,
      r.virtual_platform,
      r.external_address,
      r.external_company,
      r.external_maps_url,
      ro.name     AS room_name,
      ro.location AS room_location,
      u.user_id,
      u.full_name,
      u.email,
      'organizer' AS role
    FROM core.reservations r
    JOIN auth.users u ON u.user_id = r.created_by
    LEFT JOIN core.rooms ro ON ro.room_id = r.room_id
    WHERE r.status = 'active'
      AND r.${flagColumn} = 0
      AND u.is_active = 1
      AND r.starts_at BETWEEN DATEADD(MINUTE, ${minutesAheadMin}, SYSDATETIME())
                          AND DATEADD(MINUTE, ${minutesAheadMax}, SYSDATETIME())

    UNION

    SELECT DISTINCT
      r.reservation_id,
      r.title,
      r.starts_at,
      r.ends_at,
      r.reservation_type,
      r.meeting_link,
      r.virtual_platform,
      r.external_address,
      r.external_company,
      r.external_maps_url,
      ro.name     AS room_name,
      ro.location AS room_location,
      u.user_id,
      u.full_name,
      u.email,
      'participant' AS role
    FROM core.reservations r
    JOIN core.reservation_participants p
      ON p.reservation_id = r.reservation_id AND p.status = 'active'
    JOIN auth.users u ON u.user_id = p.user_id
    LEFT JOIN core.rooms ro ON ro.room_id = r.room_id
    WHERE r.status = 'active'
      AND r.${flagColumn} = 0
      AND u.is_active = 1
      AND r.starts_at BETWEEN DATEADD(MINUTE, ${minutesAheadMin}, SYSDATETIME())
                          AND DATEADD(MINUTE, ${minutesAheadMax}, SYSDATETIME());
  `;
}

async function sendBatch({ pool, rows, flagColumn, hoursUntil }) {
  // Agrupar por reservation_id.
  const byReservation = new Map();
  for (const row of rows) {
    if (!byReservation.has(row.reservation_id)) {
      byReservation.set(row.reservation_id, {
        info: row,
        recipients: [],
      });
    }
    byReservation.get(row.reservation_id).recipients.push({
      userId: row.user_id,
      fullName: row.full_name,
      email: row.email,
    });
  }

  for (const [reservationId, data] of byReservation) {
    try {
      for (const rec of data.recipients) {
        if (rec.email) {
          await sendReminderEmail({
            to: rec.email,
            recipientName: rec.fullName || rec.email,
            reservation: data.info,
            hoursUntil,
          });
        }

        const titleStr =
          hoursUntil >= 1
            ? `Recordatorio: ${data.info.title}`
            : `Tu reunión empieza pronto: ${data.info.title}`;
        const bodyStr =
          hoursUntil >= 1
            ? `Tu reunión es mañana a las ${fmtHora(data.info.starts_at)}.`
            : `Tu reunión empieza en 15 minutos.`;

        await createNotification({
          userId: rec.userId,
          reservationId,
          type: hoursUntil >= 1 ? "reminder_24h" : "reminder_15m",
          title: titleStr,
          body: bodyStr,
        });
      }

      // Marcar bandera para evitar reenvío.
      await pool
        .request()
        .input("rId", sql.Int, reservationId)
        .query(
          `UPDATE core.reservations SET ${flagColumn} = 1 WHERE reservation_id = @rId`
        );

      console.log(
        `[reminderJob] ${flagColumn} enviado para reserva ${reservationId} a ${data.recipients.length} ${data.recipients.length === 1 ? "persona" : "personas"}`
      );
    } catch (e) {
      console.error(
        `[reminderJob] Falla en reserva ${reservationId} (${flagColumn}):`,
        e.message
      );
    }
  }
}

async function sendReminders24h(pool) {
  // Ventana: entre +1435 y +1445 minutos (≈ 24h ± 5 min).
  const result = await pool.request().query(
    buildReminderQuery({
      flagColumn: "reminder_24h_sent",
      minutesAheadMin: 1435,
      minutesAheadMax: 1445,
    })
  );
  await sendBatch({
    pool,
    rows: result.recordset,
    flagColumn: "reminder_24h_sent",
    hoursUntil: 24,
  });
}

async function sendReminders15m(pool) {
  // Ventana: entre +10 y +20 minutos.
  const result = await pool.request().query(
    buildReminderQuery({
      flagColumn: "reminder_15m_sent",
      minutesAheadMin: 10,
      minutesAheadMax: 20,
    })
  );
  await sendBatch({
    pool,
    rows: result.recordset,
    flagColumn: "reminder_15m_sent",
    hoursUntil: 0.25,
  });
}

async function checkReminders() {
  let pool;
  try {
    pool = await getPool();
  } catch (e) {
    console.error("[reminderJob] No pool", e.message);
    return;
  }
  try {
    await sendReminders24h(pool);
  } catch (e) {
    console.error("[reminderJob] 24h", e.message);
  }
  try {
    await sendReminders15m(pool);
  } catch (e) {
    console.error("[reminderJob] 15m", e.message);
  }
}

function startReminderJob() {
  setTimeout(() => {
    checkReminders().catch((e) =>
      console.error("[reminderJob] primera corrida", e.message)
    );
  }, FIRST_DELAY_MS);
  setInterval(() => {
    checkReminders().catch((e) =>
      console.error("[reminderJob] corrida periódica", e.message)
    );
  }, RUN_INTERVAL_MS);
  console.log("[reminderJob] iniciado, cada 5 min");
}

module.exports = { startReminderJob, checkReminders };
