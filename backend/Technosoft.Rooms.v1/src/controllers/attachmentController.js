const { getPool, sql } = require("../config/db");
const { ok, err } = require("../utils/reply");
const { validateUrl } = require("../utils/urlValidator");
const { createNotification } = require("../utils/createNotification");

const LIMITS = {
  NAME: 120,
  URL: 1000,
  MAX_PER_RESERVATION: 10,
};

// Verifica si el usuario tiene acceso (organizador, participante o admin).
// Devuelve `{ hasAccess, isOrganizer, status, title }` o null si la reunión no existe.
async function fetchAccessInfo(pool, reservationId, userId, isAdmin) {
  const result = await pool
    .request()
    .input("rId", sql.Int, reservationId)
    .input("uId", sql.Int, userId)
    .query(`
      SELECT
        r.reservation_id AS reservationId,
        r.created_by     AS createdBy,
        r.status,
        r.title,
        CASE WHEN EXISTS (
          SELECT 1 FROM core.reservation_participants p
          WHERE p.reservation_id = r.reservation_id
            AND p.user_id = @uId
            AND p.status = 'active'
        ) THEN 1 ELSE 0 END AS isParticipantActive,
        CASE WHEN EXISTS (
          SELECT 1 FROM core.reservation_participants p
          WHERE p.reservation_id = r.reservation_id
            AND p.user_id = @uId
        ) THEN 1 ELSE 0 END AS isParticipantAny
      FROM core.reservations r
      WHERE r.reservation_id = @rId
    `);
  if (result.recordset.length === 0) return null;
  const row = result.recordset[0];
  const isOrganizer = row.createdBy === userId;
  return {
    hasReadAccess:
      isAdmin || isOrganizer || row.isParticipantAny === 1,
    hasWriteAccess:
      isAdmin || isOrganizer || row.isParticipantActive === 1,
    isOrganizer,
    status: row.status,
    title: row.title,
    createdBy: row.createdBy,
  };
}

// GET /api/reservations/:id/attachments
const listAttachments = async (req, res) => {
  const reservationId = parseInt(req.params.id, 10);
  if (!reservationId) {
    return res.status(400).json(err("Identificador no válido"));
  }
  try {
    const pool = await getPool();
    const access = await fetchAccessInfo(
      pool,
      reservationId,
      req.user.userId,
      req.user.role === "admin"
    );
    if (!access) {
      return res.status(404).json(err("Reunión no encontrada"));
    }
    if (!access.hasReadAccess) {
      return res.status(403).json(err("No tienes acceso a esta reunión"));
    }

    const result = await pool
      .request()
      .input("rId", sql.Int, reservationId)
      .query(`
        SELECT
          a.attachment_id  AS id,
          a.reservation_id AS reservationId,
          a.name,
          a.url,
          a.added_by       AS addedById,
          u.full_name      AS addedByName,
          u.email          AS addedByEmail,
          a.created_at     AS createdAt
        FROM core.reservation_attachments a
        JOIN auth.users u ON u.user_id = a.added_by
        WHERE a.reservation_id = @rId
        ORDER BY a.created_at DESC
      `);
    return res.json(ok(result.recordset, "OK"));
  } catch (e) {
    console.error("[attachment.list]", e);
    return res
      .status(500)
      .json(err("No fue posible cargar los adjuntos"));
  }
};

// POST /api/reservations/:id/attachments
// Body: { name, url }
const addAttachment = async (req, res) => {
  const reservationId = parseInt(req.params.id, 10);
  if (!reservationId) {
    return res.status(400).json(err("Identificador no válido"));
  }

  const nameRaw =
    req.body && typeof req.body.name === "string" ? req.body.name.trim() : "";
  const urlRaw =
    req.body && typeof req.body.url === "string" ? req.body.url.trim() : "";

  if (!nameRaw || nameRaw.length > LIMITS.NAME) {
    return res
      .status(400)
      .json(err(`Nombre inválido (1 a ${LIMITS.NAME} caracteres)`));
  }
  if (!urlRaw || urlRaw.length > LIMITS.URL) {
    return res.status(400).json(err("Enlace inválido"));
  }
  const urlCheck = validateUrl(urlRaw, "enlace");
  if (!urlCheck.valid) {
    return res.status(400).json(err(urlCheck.error));
  }

  try {
    const pool = await getPool();
    const access = await fetchAccessInfo(
      pool,
      reservationId,
      req.user.userId,
      req.user.role === "admin"
    );
    if (!access) {
      return res.status(404).json(err("Reunión no encontrada"));
    }
    if (!access.hasWriteAccess) {
      return res
        .status(403)
        .json(err("Solo el organizador o colaboradores activos pueden agregar adjuntos"));
    }
    if (access.status !== "active") {
      return res
        .status(400)
        .json(err("No puedes agregar adjuntos a una reunión cancelada"));
    }

    const countRes = await pool
      .request()
      .input("rId", sql.Int, reservationId)
      .query(
        `SELECT COUNT(*) AS total FROM core.reservation_attachments WHERE reservation_id = @rId`
      );
    if (countRes.recordset[0].total >= LIMITS.MAX_PER_RESERVATION) {
      return res
        .status(400)
        .json(
          err(`Máximo ${LIMITS.MAX_PER_RESERVATION} adjuntos por reunión`)
        );
    }

    const insertRes = await pool
      .request()
      .input("rId", sql.Int, reservationId)
      .input("name", sql.VarChar(LIMITS.NAME), nameRaw)
      .input("url", sql.VarChar(LIMITS.URL), urlRaw)
      .input("addedBy", sql.Int, req.user.userId)
      .query(`
        INSERT INTO core.reservation_attachments (reservation_id, name, url, added_by)
        OUTPUT INSERTED.attachment_id AS id
        VALUES (@rId, @name, @url, @addedBy)
      `);

    // Notificación interna sutil al resto de participantes y al organizador
    // (si no fue quien agregó). Sin correo, para evitar ruido.
    try {
      const others = await pool
        .request()
        .input("rId", sql.Int, reservationId)
        .input("uId", sql.Int, req.user.userId)
        .query(`
          SELECT DISTINCT p.user_id AS userId
          FROM core.reservation_participants p
          WHERE p.reservation_id = @rId
            AND p.status = 'active'
            AND p.user_id <> @uId
          UNION
          SELECT r.created_by AS userId
          FROM core.reservations r
          WHERE r.reservation_id = @rId
            AND r.created_by <> @uId
        `);
      const recipientIds = others.recordset
        .map((row) => row.userId)
        .filter((id) => Number.isInteger(id) && id > 0);
      const adderName = req.user.fullName || "Un colaborador";
      for (const uid of recipientIds) {
        await createNotification({
          userId: uid,
          reservationId,
          type: "attachment_added",
          title: `Nuevo adjunto en "${access.title}"`,
          body: `${adderName} compartió "${nameRaw}"`,
        });
      }
    } catch (notifErr) {
      console.warn("[attachment.add] notif fallo:", notifErr.message);
    }

    return res.json(
      ok({ id: insertRes.recordset[0].id }, "Adjunto agregado")
    );
  } catch (e) {
    console.error("[attachment.add]", e);
    return res
      .status(500)
      .json(err("No fue posible agregar el adjunto"));
  }
};

// DELETE /api/reservations/:id/attachments/:attachmentId
const deleteAttachment = async (req, res) => {
  const reservationId = parseInt(req.params.id, 10);
  const attachmentId = parseInt(req.params.attachmentId, 10);
  if (!reservationId || !attachmentId) {
    return res.status(400).json(err("Identificador no válido"));
  }
  try {
    const pool = await getPool();
    const check = await pool
      .request()
      .input("aId", sql.Int, attachmentId)
      .input("rId", sql.Int, reservationId)
      .query(`
        SELECT
          a.added_by AS addedBy,
          r.created_by AS createdBy
        FROM core.reservation_attachments a
        JOIN core.reservations r ON r.reservation_id = a.reservation_id
        WHERE a.attachment_id = @aId AND a.reservation_id = @rId
      `);
    if (check.recordset.length === 0) {
      return res.status(404).json(err("Adjunto no encontrado"));
    }
    const row = check.recordset[0];
    const me = req.user.userId;
    const isAdmin = req.user.role === "admin";
    if (!isAdmin && row.addedBy !== me && row.createdBy !== me) {
      return res
        .status(403)
        .json(err("Solo quien lo agregó o el organizador pueden eliminarlo"));
    }
    await pool
      .request()
      .input("aId", sql.Int, attachmentId)
      .query(
        `DELETE FROM core.reservation_attachments WHERE attachment_id = @aId`
      );
    return res.json(ok({}, "Adjunto eliminado"));
  } catch (e) {
    console.error("[attachment.delete]", e);
    return res
      .status(500)
      .json(err("No fue posible eliminar el adjunto"));
  }
};

module.exports = { listAttachments, addAttachment, deleteAttachment };
