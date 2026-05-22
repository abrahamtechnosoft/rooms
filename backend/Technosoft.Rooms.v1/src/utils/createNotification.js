const { getPool, sql } = require('../config/db');

async function createNotification({ userId, reservationId, type, title, body }) {
  if (!userId || !type || !title) return;
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('uId', sql.Int, userId)
      .input('rId', sql.Int, reservationId || null)
      .input('type', sql.VarChar(30), type)
      .input('title', sql.VarChar(200), String(title).slice(0, 200))
      .input('body', sql.VarChar(500), body ? String(body).slice(0, 500) : null)
      .query(`
        INSERT INTO core.notifications (user_id, reservation_id, type, title, body)
        VALUES (@uId, @rId, @type, @title, @body)
      `);
  } catch (e) {
    console.error('[createNotification] fallo:', e.message);
  }
}

async function createNotificationsForParticipants({
  participantIds,
  reservationId,
  type,
  title,
  body,
}) {
  if (!participantIds || participantIds.length === 0) return;
  for (const uid of participantIds) {
    await createNotification({
      userId: uid,
      reservationId,
      type,
      title,
      body,
    });
  }
}

module.exports = { createNotification, createNotificationsForParticipants };
