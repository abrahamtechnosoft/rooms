const { getPool, sql } = require("../config/db");
const { ok, err } = require("../utils/reply");

function mapReminder(r) {
  return {
    reminderId: r.reminder_id,
    title: r.title,
    content: r.content || null,
    remindAt: r.remind_at,
    isDone: r.is_done === true || r.is_done === 1,
    notified: r.notified === true || r.notified === 1,
    notifiedAt: r.notified_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at || null,
  };
}

async function getReminders(req, res) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("userId", sql.Int, req.user.userId)
      .query(`
        SELECT
          reminder_id,
          title,
          content,
          remind_at,
          is_done,
          notified,
          notified_at,
          created_at,
          updated_at
        FROM core.user_reminders
        WHERE user_id = @userId
        ORDER BY remind_at ASC
      `);
    return res.json(ok(result.recordset.map(mapReminder)));
  } catch (e) {
    console.error("[reminders.getReminders]", e);
    return res
      .status(500)
      .json(err("No fue posible cargar los recordatorios"));
  }
}

async function createReminder(req, res) {
  try {
    const body = req.body || {};
    const titleRaw = typeof body.title === "string" ? body.title.trim() : "";
    if (titleRaw.length === 0) {
      return res.status(400).json(err("El título es requerido"));
    }
    if (titleRaw.length > 120) {
      return res
        .status(400)
        .json(err("El título no puede superar 120 caracteres"));
    }
    if (!body.remindAt) {
      return res
        .status(400)
        .json(err("La fecha del recordatorio es requerida"));
    }
    const remindAtDate = new Date(body.remindAt);
    if (isNaN(remindAtDate.getTime())) {
      return res.status(400).json(err("Fecha inválida"));
    }
    const contentRaw =
      typeof body.content === "string" && body.content.trim().length > 0
        ? body.content.trim().slice(0, 2000)
        : null;

    const pool = await getPool();
    const result = await pool
      .request()
      .input("userId", sql.Int, req.user.userId)
      .input("title", sql.NVarChar(120), titleRaw.slice(0, 120))
      .input("content", sql.NVarChar(2000), contentRaw)
      .input("remindAt", sql.DateTime2, remindAtDate)
      .query(`
        INSERT INTO core.user_reminders (user_id, title, content, remind_at)
        OUTPUT INSERTED.reminder_id
        VALUES (@userId, @title, @content, @remindAt)
      `);
    return res
      .status(201)
      .json(ok({ reminderId: result.recordset[0].reminder_id }, "Recordatorio creado"));
  } catch (e) {
    console.error("[reminders.createReminder]", e);
    return res
      .status(500)
      .json(err("No fue posible crear el recordatorio"));
  }
}

async function updateReminder(req, res) {
  try {
    const reminderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reminderId) || reminderId <= 0) {
      return res.status(400).json(err("Identificador no válido"));
    }
    const body = req.body || {};
    const pool = await getPool();
    const check = await pool
      .request()
      .input("id", sql.Int, reminderId)
      .query(
        "SELECT user_id, title, content, remind_at, is_done FROM core.user_reminders WHERE reminder_id = @id"
      );
    if (check.recordset.length === 0) {
      return res.status(404).json(err("Recordatorio no encontrado"));
    }
    if (check.recordset[0].user_id !== req.user.userId) {
      return res.status(403).json(err("Sin permisos"));
    }
    const current = check.recordset[0];

    const hasTitle = Object.prototype.hasOwnProperty.call(body, "title");
    const hasContent = Object.prototype.hasOwnProperty.call(body, "content");
    const hasRemindAt = Object.prototype.hasOwnProperty.call(body, "remindAt");
    const hasIsDone = Object.prototype.hasOwnProperty.call(body, "isDone");

    let nextTitle = current.title;
    if (hasTitle) {
      const t =
        typeof body.title === "string" ? body.title.trim() : "";
      if (t.length === 0) {
        return res.status(400).json(err("El título es requerido"));
      }
      nextTitle = t.slice(0, 120);
    }

    let nextContent = current.content;
    if (hasContent) {
      nextContent =
        typeof body.content === "string" && body.content.trim().length > 0
          ? body.content.trim().slice(0, 2000)
          : null;
    }

    let nextRemindAt = current.remind_at;
    if (hasRemindAt) {
      const d = new Date(body.remindAt);
      if (isNaN(d.getTime())) {
        return res.status(400).json(err("Fecha inválida"));
      }
      nextRemindAt = d;
    }

    const nextIsDone = hasIsDone
      ? body.isDone === true
        ? 1
        : 0
      : current.is_done === true || current.is_done === 1
        ? 1
        : 0;

    // Si cambió la fecha respecto a la actual, resetear notified para que
    // el dispatcher pueda volver a notificar a la nueva hora.
    const currentMs = new Date(current.remind_at).getTime();
    const nextMs = new Date(nextRemindAt).getTime();
    const dateChanged = currentMs !== nextMs;

    await pool
      .request()
      .input("id", sql.Int, reminderId)
      .input("title", sql.NVarChar(120), nextTitle)
      .input("content", sql.NVarChar(2000), nextContent)
      .input("remindAt", sql.DateTime2, nextRemindAt)
      .input("isDone", sql.Bit, nextIsDone)
      .input("dateChanged", sql.Bit, dateChanged ? 1 : 0)
      .query(`
        UPDATE core.user_reminders
        SET title = @title,
            content = @content,
            remind_at = @remindAt,
            is_done = @isDone,
            updated_at = SYSDATETIME(),
            notified = CASE WHEN @dateChanged = 1 THEN 0 ELSE notified END,
            notified_at = CASE WHEN @dateChanged = 1 THEN NULL ELSE notified_at END
        WHERE reminder_id = @id
      `);
    return res.json(ok({ reminderId }, "Recordatorio actualizado"));
  } catch (e) {
    console.error("[reminders.updateReminder]", e);
    return res
      .status(500)
      .json(err("No fue posible actualizar el recordatorio"));
  }
}

async function deleteReminder(req, res) {
  try {
    const reminderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reminderId) || reminderId <= 0) {
      return res.status(400).json(err("Identificador no válido"));
    }
    const pool = await getPool();
    const check = await pool
      .request()
      .input("id", sql.Int, reminderId)
      .query("SELECT user_id FROM core.user_reminders WHERE reminder_id = @id");
    if (check.recordset.length === 0) {
      return res.status(404).json(err("Recordatorio no encontrado"));
    }
    if (check.recordset[0].user_id !== req.user.userId) {
      return res.status(403).json(err("Sin permisos"));
    }
    await pool
      .request()
      .input("id", sql.Int, reminderId)
      .query("DELETE FROM core.user_reminders WHERE reminder_id = @id");
    return res.json(ok({ reminderId }, "Recordatorio eliminado"));
  } catch (e) {
    console.error("[reminders.deleteReminder]", e);
    return res
      .status(500)
      .json(err("No fue posible eliminar el recordatorio"));
  }
}

async function markNotified(req, res) {
  try {
    const reminderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(reminderId) || reminderId <= 0) {
      return res.status(400).json(err("Identificador no válido"));
    }
    const pool = await getPool();
    await pool
      .request()
      .input("id", sql.Int, reminderId)
      .input("userId", sql.Int, req.user.userId)
      .query(`
        UPDATE core.user_reminders
        SET notified = 1, notified_at = SYSDATETIME()
        WHERE reminder_id = @id AND user_id = @userId
      `);
    return res.json(ok({ reminderId }));
  } catch (e) {
    console.error("[reminders.markNotified]", e);
    return res
      .status(500)
      .json(err("No fue posible marcar el recordatorio"));
  }
}

module.exports = {
  getReminders,
  createReminder,
  updateReminder,
  deleteReminder,
  markNotified,
};
