const { getPool, sql } = require("../config/db");
const { ok, err } = require("../utils/reply");

// Default: ultimos 30 dias.
function parseRange(query) {
  const now = new Date();
  const to = query && query.to ? new Date(query.to) : now;
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = query && query.from ? new Date(query.from) : defaultFrom;
  return { from, to };
}

function requireAdmin(req, res) {
  if (req.user.role !== "admin") {
    res.status(403).json(err("Solo administradores"));
    return false;
  }
  return true;
}

const getEvents = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { from, to } = parseRange(req.query);
    const pool = await getPool();
    const result = await pool
      .request()
      .input("from", sql.DateTime2, from)
      .input("to", sql.DateTime2, to)
      .query(`
        SELECT
          'reservation_cancelled' AS eventType,
          r.reservation_id        AS reservationId,
          r.title                 AS reservationTitle,
          r.cancelled_at          AS eventAt,
          r.cancel_reason         AS reason,
          r.cancelled_by          AS actorId,
          cb.full_name            AS actorName,
          cb.email                AS actorEmail,
          cb.avatar_url           AS actorAvatarUrl,
          CASE
            WHEN r.cancelled_at >= r.starts_at AND r.cancelled_at < r.ends_at
              THEN 1 ELSE 0
          END                     AS inProgress
        FROM core.reservations r
        LEFT JOIN auth.users cb ON cb.user_id = r.cancelled_by
        WHERE r.status = 'cancelled'
          AND r.cancelled_at IS NOT NULL
          AND r.cancelled_at >= @from
          AND r.cancelled_at <= @to

        UNION ALL

        SELECT
          'participation_cancelled' AS eventType,
          rp.reservation_id         AS reservationId,
          r.title                   AS reservationTitle,
          rp.cancelled_at           AS eventAt,
          rp.cancel_reason          AS reason,
          rp.user_id                AS actorId,
          u.full_name               AS actorName,
          u.email                   AS actorEmail,
          u.avatar_url              AS actorAvatarUrl,
          CASE
            WHEN rp.cancelled_at >= r.starts_at AND rp.cancelled_at < r.ends_at
              THEN 1 ELSE 0
          END                       AS inProgress
        FROM core.reservation_participants rp
        JOIN core.reservations r ON r.reservation_id = rp.reservation_id
        JOIN auth.users u        ON u.user_id        = rp.user_id
        WHERE rp.status = 'cancelled'
          AND rp.cancelled_at IS NOT NULL
          AND rp.cancelled_at >= @from
          AND rp.cancelled_at <= @to

        ORDER BY eventAt DESC
      `);

    const items = result.recordset.map((r) => ({
      eventType: r.eventType,
      reservationId: r.reservationId,
      reservationTitle: r.reservationTitle,
      eventAt: r.eventAt,
      reason: r.reason || null,
      actorId: r.actorId,
      actorName: r.actorName,
      actorEmail: r.actorEmail,
      actorAvatarUrl: r.actorAvatarUrl,
      inProgress: r.inProgress === 1,
    }));
    return res.json(ok(items, "OK"));
  } catch (e) {
    console.error("[adminReports.getEvents]", e);
    return res
      .status(500)
      .json(err("No fue posible obtener los registros"));
  }
};

const getSummary = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { from, to } = parseRange(req.query);
    const pool = await getPool();

    const cancellationsRes = await pool
      .request()
      .input("from", sql.DateTime2, from)
      .input("to", sql.DateTime2, to)
      .query(`
        SELECT
          SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END)
            AS totalReservationCancellations,
          SUM(CASE
                WHEN r.status = 'cancelled'
                 AND r.cancelled_at IS NOT NULL
                 AND r.cancelled_at >= r.starts_at
                 AND r.cancelled_at < r.ends_at
              THEN 1 ELSE 0
              END) AS cancellationsInProgress
        FROM core.reservations r
        WHERE (r.cancelled_at BETWEEN @from AND @to)
           OR (r.cancelled_at IS NULL AND r.created_at BETWEEN @from AND @to)
      `);

    const partsRes = await pool
      .request()
      .input("from", sql.DateTime2, from)
      .input("to", sql.DateTime2, to)
      .query(`
        SELECT COUNT(*) AS totalParticipationCancellations
        FROM core.reservation_participants rp
        WHERE rp.status = 'cancelled'
          AND rp.cancelled_at IS NOT NULL
          AND rp.cancelled_at BETWEEN @from AND @to
      `);

    const topUsersRes = await pool
      .request()
      .input("from", sql.DateTime2, from)
      .input("to", sql.DateTime2, to)
      .query(`
        SELECT TOP 5
          u.user_id    AS userId,
          u.full_name  AS fullName,
          u.email,
          u.avatar_url AS avatarUrl,
          COUNT(*)     AS cancellations
        FROM core.reservation_participants rp
        JOIN auth.users u ON u.user_id = rp.user_id
        WHERE rp.status = 'cancelled'
          AND rp.cancelled_at IS NOT NULL
          AND rp.cancelled_at BETWEEN @from AND @to
        GROUP BY u.user_id, u.full_name, u.email, u.avatar_url
        ORDER BY cancellations DESC
      `);

    const topRoomsRes = await pool
      .request()
      .input("from", sql.DateTime2, from)
      .input("to", sql.DateTime2, to)
      .query(`
        SELECT
          ro.room_id    AS roomId,
          ro.name       AS roomName,
          COUNT(*)      AS totalMeetings,
          SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
        FROM core.reservations r
        JOIN core.rooms ro ON ro.room_id = r.room_id
        WHERE r.reservation_type = 'physical'
          AND r.created_at BETWEEN @from AND @to
        GROUP BY ro.room_id, ro.name
        ORDER BY totalMeetings DESC
      `);

    const c = cancellationsRes.recordset[0] || {};
    const p = partsRes.recordset[0] || {};
    return res.json(
      ok(
        {
          range: {
            from: from.toISOString(),
            to: to.toISOString(),
          },
          cancellations: {
            totalReservationCancellations:
              c.totalReservationCancellations || 0,
            cancellationsInProgress: c.cancellationsInProgress || 0,
          },
          participations: {
            totalParticipationCancellations:
              p.totalParticipationCancellations || 0,
          },
          topUsers: topUsersRes.recordset.map((u) => ({
            userId: u.userId,
            fullName: u.fullName,
            email: u.email,
            avatarUrl: u.avatarUrl,
            cancellations: u.cancellations,
          })),
          topRooms: topRoomsRes.recordset.map((r) => ({
            roomId: r.roomId,
            roomName: r.roomName,
            totalMeetings: r.totalMeetings,
            cancelled: r.cancelled || 0,
          })),
        },
        "OK"
      )
    );
  } catch (e) {
    console.error("[adminReports.getSummary]", e);
    return res
      .status(500)
      .json(err("No fue posible obtener el resumen"));
  }
};

module.exports = { getEvents, getSummary };
