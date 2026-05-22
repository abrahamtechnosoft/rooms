const { getPool, sql } = require('../config/db');
const { ok, err } = require('../utils/reply');

async function listMine(req, res) {
  try {
    const unreadOnly = String(req.query.unreadOnly || '') === 'true';
    const pool = await getPool();
    const result = await pool
      .request()
      .input('uId', sql.Int, req.user.userId)
      .query(`
        SELECT TOP 100
          notification_id AS id,
          reservation_id  AS reservationId,
          type,
          title,
          body,
          is_read         AS isRead,
          created_at      AS createdAt,
          read_at         AS readAt
        FROM core.notifications
        WHERE user_id = @uId
          ${unreadOnly ? 'AND is_read = 0' : ''}
        ORDER BY
          is_read ASC,
          CASE WHEN is_read = 0 THEN created_at END DESC,
          CASE WHEN is_read = 1 THEN read_at END DESC
      `);
    const items = result.recordset.map((n) => ({ ...n, isRead: !!n.isRead }));
    const unread = items.filter((n) => !n.isRead).length;
    return res.json(ok({ items, unreadCount: unread }, 'OK'));
  } catch (e) {
    console.error('[notifications.listMine]', e);
    return res
      .status(500)
      .json(err('No fue posible cargar las notificaciones'));
  }
}

async function unreadCount(req, res) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('uId', sql.Int, req.user.userId)
      .query(`
        SELECT COUNT(*) AS count
        FROM core.notifications
        WHERE user_id = @uId AND is_read = 0
      `);
    return res.json(ok({ count: result.recordset[0].count }, 'OK'));
  } catch (e) {
    console.error('[notifications.unreadCount]', e);
    return res
      .status(500)
      .json(err('No fue posible obtener el contador'));
  }
}

async function markAllRead(req, res) {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('uId', sql.Int, req.user.userId)
      .query(`
        UPDATE core.notifications
        SET is_read = 1, read_at = SYSDATETIME()
        WHERE user_id = @uId AND is_read = 0
      `);
    return res.json(ok({}, 'OK'));
  } catch (e) {
    console.error('[notifications.markAllRead]', e);
    return res
      .status(500)
      .json(err('No fue posible marcar como leídas'));
  }
}

async function markByReservation(req, res) {
  const rId = parseInt(req.params.reservationId, 10);
  if (!rId) return res.status(400).json(err('Identificador no valido'));
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('uId', sql.Int, req.user.userId)
      .input('rId', sql.Int, rId)
      .query(`
        UPDATE core.notifications
        SET is_read = 1, read_at = SYSDATETIME()
        WHERE user_id = @uId
          AND reservation_id = @rId
          AND is_read = 0
      `);
    return res.json(ok({}, 'OK'));
  } catch (e) {
    console.error('[notifications.markByReservation]', e);
    return res
      .status(500)
      .json(err('No fue posible marcar como leídas'));
  }
}

async function markOneRead(req, res) {
  const nId = parseInt(req.params.id, 10);
  if (!nId) return res.status(400).json(err('Identificador no valido'));
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('uId', sql.Int, req.user.userId)
      .input('nId', sql.Int, nId)
      .query(`
        UPDATE core.notifications
        SET is_read = 1, read_at = SYSDATETIME()
        WHERE user_id = @uId AND notification_id = @nId
      `);
    return res.json(ok({}, 'OK'));
  } catch (e) {
    console.error('[notifications.markOneRead]', e);
    return res
      .status(500)
      .json(err('No fue posible marcar como leída'));
  }
}

module.exports = {
  listMine,
  unreadCount,
  markAllRead,
  markOneRead,
  markByReservation,
};
