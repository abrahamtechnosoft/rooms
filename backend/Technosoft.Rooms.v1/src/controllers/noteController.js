const { getPool, sql } = require("../config/db");
const { ok, err } = require("../utils/reply");

const DEFAULT_COLOR = "#FEF3C7";

function mapNote(n) {
  return {
    noteId: n.note_id,
    authorId: n.author_id,
    authorName: n.author_name,
    authorAvatarUrl: n.author_avatar_url || null,
    departmentId: n.department_id != null ? n.department_id : null,
    visibility: n.visibility,
    title: n.title || null,
    content: n.content,
    colorHex: n.color_hex || DEFAULT_COLOR,
    isDone: n.is_done === true || n.is_done === 1,
    isPinned: n.is_pinned === true || n.is_pinned === 1,
    sortOrder: n.sort_order != null ? n.sort_order : 0,
    createdAt: n.created_at,
    updatedAt: n.updated_at || null,
  };
}

/**
 * Busca el department_id del usuario autenticado. El JWT actual no lo
 * incluye, asi que lo consultamos en cada request. Es 1 lookup barato por
 * endpoint, suficiente para el volumen esperado.
 */
async function fetchUserDepartmentId(userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input("uId", sql.Int, userId)
    .query(
      "SELECT department_id FROM auth.users WHERE user_id = @uId"
    );
  if (result.recordset.length === 0) return null;
  const v = result.recordset[0].department_id;
  return v != null ? v : null;
}

async function getNotes(req, res) {
  try {
    const userId = req.user.userId;
    const deptId = await fetchUserDepartmentId(userId);
    const pool = await getPool();
    const result = await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("deptId", sql.Int, deptId)
      .query(`
        SELECT
          n.note_id,
          n.author_id,
          n.department_id,
          n.visibility,
          n.title,
          n.content,
          n.color_hex,
          n.is_done,
          n.is_pinned,
          n.sort_order,
          n.created_at,
          n.updated_at,
          u.full_name  AS author_name,
          u.avatar_url AS author_avatar_url
        FROM core.user_notes n
        INNER JOIN auth.users u ON u.user_id = n.author_id
        WHERE
          (n.visibility = 'personal' AND n.author_id = @userId)
          OR
          (n.visibility = 'department' AND n.department_id = @deptId AND @deptId IS NOT NULL)
        ORDER BY n.is_pinned DESC, n.created_at DESC
      `);
    return res.json(ok(result.recordset.map(mapNote)));
  } catch (e) {
    console.error("[notes.getNotes]", e);
    return res.status(500).json(err("No fue posible cargar las notas"));
  }
}

async function createNote(req, res) {
  try {
    const body = req.body || {};
    const visibility = String(body.visibility || "").trim();
    const titleRaw = body.title;
    const contentRaw = body.content;
    const colorHexRaw = body.colorHex;

    if (visibility !== "personal" && visibility !== "department") {
      return res.status(400).json(err("Visibilidad no válida"));
    }
    if (typeof contentRaw !== "string" || contentRaw.trim().length === 0) {
      return res.status(400).json(err("El contenido es requerido"));
    }
    if (contentRaw.length > 2000) {
      return res.status(400).json(err("El contenido no puede superar 2000 caracteres"));
    }
    const title =
      titleRaw == null || String(titleRaw).trim().length === 0
        ? null
        : String(titleRaw).trim().slice(0, 120);
    const colorHex =
      typeof colorHexRaw === "string" && colorHexRaw.trim().length > 0
        ? colorHexRaw.trim().slice(0, 20)
        : DEFAULT_COLOR;

    const userId = req.user.userId;
    let departmentId = null;
    if (visibility === "department") {
      departmentId = await fetchUserDepartmentId(userId);
      if (departmentId == null) {
        return res
          .status(400)
          .json(
            err(
              "Debes tener un departamento asignado para crear notas del departamento"
            )
          );
      }
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("authorId", sql.Int, userId)
      .input("deptId", sql.Int, departmentId)
      .input("visibility", sql.VarChar(20), visibility)
      .input("title", sql.NVarChar(120), title)
      .input("content", sql.NVarChar(2000), contentRaw.trim())
      .input("colorHex", sql.VarChar(20), colorHex)
      .query(`
        INSERT INTO core.user_notes
          (author_id, department_id, visibility, title, content, color_hex)
        OUTPUT INSERTED.note_id
        VALUES (@authorId, @deptId, @visibility, @title, @content, @colorHex)
      `);
    const noteId = result.recordset[0].note_id;
    return res.status(201).json(ok({ noteId }, "Nota creada"));
  } catch (e) {
    console.error("[notes.createNote]", e);
    return res.status(500).json(err("No fue posible crear la nota"));
  }
}

async function updateNote(req, res) {
  try {
    const noteId = parseInt(req.params.id, 10);
    if (!Number.isInteger(noteId) || noteId <= 0) {
      return res.status(400).json(err("Identificador no válido"));
    }
    const body = req.body || {};
    const pool = await getPool();
    const check = await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .query(
        "SELECT author_id, color_hex, title, content, is_done FROM core.user_notes WHERE note_id = @noteId"
      );
    if (check.recordset.length === 0) {
      return res.status(404).json(err("Nota no encontrada"));
    }
    if (check.recordset[0].author_id !== req.user.userId) {
      return res
        .status(403)
        .json(err("Solo el autor puede editar esta nota"));
    }

    const current = check.recordset[0];
    const hasTitle = Object.prototype.hasOwnProperty.call(body, "title");
    const hasContent = Object.prototype.hasOwnProperty.call(body, "content");
    const hasColor = Object.prototype.hasOwnProperty.call(body, "colorHex");
    const hasIsDone = Object.prototype.hasOwnProperty.call(body, "isDone");

    const nextTitle = hasTitle
      ? body.title == null || String(body.title).trim().length === 0
        ? null
        : String(body.title).trim().slice(0, 120)
      : current.title;
    const nextContent = hasContent ? String(body.content || "").trim() : current.content;
    if (nextContent.length === 0) {
      return res.status(400).json(err("El contenido es requerido"));
    }
    if (nextContent.length > 2000) {
      return res
        .status(400)
        .json(err("El contenido no puede superar 2000 caracteres"));
    }
    const nextColor = hasColor
      ? typeof body.colorHex === "string" && body.colorHex.trim().length > 0
        ? body.colorHex.trim().slice(0, 20)
        : DEFAULT_COLOR
      : current.color_hex || DEFAULT_COLOR;
    const nextIsDone = hasIsDone
      ? body.isDone === true
        ? 1
        : 0
      : current.is_done === true || current.is_done === 1
        ? 1
        : 0;

    await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .input("title", sql.NVarChar(120), nextTitle)
      .input("content", sql.NVarChar(2000), nextContent)
      .input("colorHex", sql.VarChar(20), nextColor)
      .input("isDone", sql.Bit, nextIsDone)
      .query(`
        UPDATE core.user_notes
        SET title = @title,
            content = @content,
            color_hex = @colorHex,
            is_done = @isDone,
            updated_at = SYSDATETIME()
        WHERE note_id = @noteId
      `);
    return res.json(ok({ noteId }, "Nota actualizada"));
  } catch (e) {
    console.error("[notes.updateNote]", e);
    return res.status(500).json(err("No fue posible actualizar la nota"));
  }
}

async function deleteNote(req, res) {
  try {
    const noteId = parseInt(req.params.id, 10);
    if (!Number.isInteger(noteId) || noteId <= 0) {
      return res.status(400).json(err("Identificador no válido"));
    }
    const pool = await getPool();
    const check = await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .query("SELECT author_id FROM core.user_notes WHERE note_id = @noteId");
    if (check.recordset.length === 0) {
      return res.status(404).json(err("Nota no encontrada"));
    }
    if (check.recordset[0].author_id !== req.user.userId) {
      return res
        .status(403)
        .json(err("Solo el autor puede eliminar esta nota"));
    }
    await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .query("DELETE FROM core.user_notes WHERE note_id = @noteId");
    return res.json(ok({ noteId }, "Nota eliminada"));
  } catch (e) {
    console.error("[notes.deleteNote]", e);
    return res.status(500).json(err("No fue posible eliminar la nota"));
  }
}

async function togglePinned(req, res) {
  try {
    const noteId = parseInt(req.params.id, 10);
    if (!Number.isInteger(noteId) || noteId <= 0) {
      return res.status(400).json(err("Identificador no válido"));
    }
    const pool = await getPool();
    const check = await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .query(
        "SELECT author_id, is_pinned FROM core.user_notes WHERE note_id = @noteId"
      );
    if (check.recordset.length === 0) {
      return res.status(404).json(err("Nota no encontrada"));
    }
    if (check.recordset[0].author_id !== req.user.userId) {
      return res
        .status(403)
        .json(err("Solo el autor puede fijar esta nota"));
    }
    const newValue =
      check.recordset[0].is_pinned === true ||
      check.recordset[0].is_pinned === 1
        ? 0
        : 1;
    await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .input("isPinned", sql.Bit, newValue)
      .query(
        "UPDATE core.user_notes SET is_pinned = @isPinned, updated_at = SYSDATETIME() WHERE note_id = @noteId"
      );
    return res.json(
      ok({ noteId, isPinned: !!newValue }, newValue ? "Nota fijada" : "Nota desfijada")
    );
  } catch (e) {
    console.error("[notes.togglePinned]", e);
    return res
      .status(500)
      .json(err("No fue posible actualizar la nota"));
  }
}

module.exports = {
  getNotes,
  createNote,
  updateNote,
  deleteNote,
  togglePinned,
};
