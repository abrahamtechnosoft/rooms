const { getPool, sql } = require('../config/db');
const { ok, err } = require('../utils/reply');
const { logHistory } = require('../utils/historyLogger');
const { notifySummaryUpdated } = require('../services/notificationService');

const SUMMARY_LIMIT = 2000;

async function checkAccess(pool, reservationId, user) {
  if (user.role === 'admin') {
    const r = await pool
      .request()
      .input('rId', sql.Int, reservationId)
      .query(`SELECT created_by AS createdBy FROM core.reservations WHERE reservation_id = @rId`);
    if (r.recordset.length === 0) return null;
    return { isOrganizer: r.recordset[0].createdBy === user.userId };
  }
  const r = await pool
    .request()
    .input('rId', sql.Int, reservationId)
    .input('uId', sql.Int, user.userId)
    .query(`
      SELECT r.created_by AS createdBy
      FROM core.reservations r
      LEFT JOIN core.reservation_participants p
        ON p.reservation_id = r.reservation_id
       AND p.user_id = @uId
       AND p.status = 'active'
      WHERE r.reservation_id = @rId
        AND (r.created_by = @uId OR p.user_id = @uId)
    `);
  if (r.recordset.length === 0) return null;
  return { isOrganizer: r.recordset[0].createdBy === user.userId };
}

async function getSummary(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err('Identificador no valido'));
  try {
    const pool = await getPool();
    const access = await checkAccess(pool, id, req.user);
    if (!access) return res.status(403).json(err('Sin acceso'));

    const result = await pool
      .request()
      .input('rId', sql.Int, id)
      .query(`
        SELECT
          s.item_id     AS id,
          s.author_id   AS authorId,
          u.full_name   AS authorName,
          u.email       AS authorEmail,
          u.avatar_url  AS authorAvatarUrl,
          s.content,
          s.item_order  AS itemOrder,
          s.created_at  AS createdAt
        FROM core.reservation_summary_items s
        JOIN auth.users u ON u.user_id = s.author_id
        WHERE s.reservation_id = @rId
        ORDER BY s.item_order ASC, s.created_at ASC
      `);

    return res.json(ok(result.recordset, 'OK'));
  } catch (e) {
    console.error('[summary.get]', e);
    return res.status(500).json(err('No fue posible cargar el resumen'));
  }
}

async function addSummaryItem(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err('Identificador no valido'));
  const content =
    req.body && typeof req.body.content === 'string'
      ? req.body.content.trim()
      : '';
  if (!content) {
    return res.status(400).json(err('El contenido no puede estar vacío'));
  }
  if (content.length > SUMMARY_LIMIT) {
    return res
      .status(400)
      .json(err(`El contenido no puede superar ${SUMMARY_LIMIT} caracteres`));
  }

  try {
    const pool = await getPool();
    const access = await checkAccess(pool, id, req.user);
    if (!access) return res.status(403).json(err('Sin acceso'));

    const existing = await pool
      .request()
      .input('rId', sql.Int, id)
      .query(`
        SELECT COUNT(*) AS total, ISNULL(MAX(item_order), 0) AS maxOrder
        FROM core.reservation_summary_items
        WHERE reservation_id = @rId
      `);
    const isFirst = existing.recordset[0].total === 0;
    const nextOrder = (existing.recordset[0].maxOrder || 0) + 1;

    const insertRes = await pool
      .request()
      .input('rId', sql.Int, id)
      .input('authorId', sql.Int, req.user.userId)
      .input('content', sql.NVarChar(SUMMARY_LIMIT), content)
      .input('order', sql.Int, nextOrder)
      .query(`
        INSERT INTO core.reservation_summary_items
          (reservation_id, author_id, content, item_order, created_at)
        OUTPUT INSERTED.item_id AS id
        VALUES (@rId, @authorId, @content, @order, SYSDATETIME())
      `);

    const newItemId = insertRes.recordset[0].id;

    await logHistory({
      reservationId: id,
      actionType: isFirst ? 'summary_created' : 'summary_item_added',
      actionBy: req.user.userId,
      details: { itemId: newItemId, itemOrder: nextOrder },
    });

    try {
      await notifySummaryUpdated({
        reservationId: id,
        authorId: req.user.userId,
        isFirst,
      });
    } catch (e) {
      console.error('[summary.add.notify]', e.message);
    }

    return res.json(
      ok({ id: newItemId }, isFirst ? 'Resumen iniciado' : 'Punto agregado')
    );
  } catch (e) {
    console.error('[summary.add]', e);
    return res.status(500).json(err('No fue posible agregar el punto'));
  }
}

module.exports = { getSummary, addSummaryItem };
