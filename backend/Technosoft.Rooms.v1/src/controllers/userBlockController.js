const { getPool, sql } = require("../config/db");
const { ok, err } = require("../utils/reply");

const LIMITS = {
  NAME: 80,
};

const TIME_RE = /^([0-1]\d|2[0-3]):[0-5]\d$/;
const DAYS_RE = /^[1-7](,[1-7])*$/;

function normalizeDays(daysCsv) {
  const arr = String(daysCsv)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const uniq = [...new Set(arr)].sort();
  return uniq.join(",");
}

// GET /api/users/me/blocks
const listMyBlocks = async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("uId", sql.Int, req.user.userId)
      .query(`
        SELECT
          block_id        AS id,
          name,
          block_type      AS blockType,
          days_of_week    AS daysOfWeek,
          CONVERT(VARCHAR(5), start_time, 108) AS startTime,
          CONVERT(VARCHAR(5), end_time, 108)   AS endTime,
          start_at        AS startAt,
          end_at          AS endAt,
          is_active       AS isActive,
          created_at      AS createdAt
        FROM auth.user_blocks
        WHERE user_id = @uId
        ORDER BY is_active DESC, created_at DESC
      `);
    return res.json(ok(result.recordset, "OK"));
  } catch (e) {
    console.error("[userBlock.list]", e);
    return res.status(500).json(err("No fue posible cargar los bloqueos"));
  }
};

// POST /api/users/me/blocks
const createMyBlock = async (req, res) => {
  const body = req.body || {};
  const name =
    typeof body.name === "string" ? body.name.trim() : "";
  const { blockType } = body;

  if (!name || name.length > LIMITS.NAME) {
    return res
      .status(400)
      .json(err(`Nombre inválido (1 a ${LIMITS.NAME} caracteres)`));
  }
  if (!["recurring", "one_time"].includes(blockType)) {
    return res.status(400).json(err("Tipo de bloqueo inválido"));
  }

  let daysOfWeek = null;
  let startTime = null;
  let endTime = null;
  let startAt = null;
  let endAt = null;

  if (blockType === "recurring") {
    daysOfWeek = body.daysOfWeek ? normalizeDays(body.daysOfWeek) : "";
    if (!DAYS_RE.test(daysOfWeek)) {
      return res.status(400).json(err("Días de la semana inválidos"));
    }
    if (!TIME_RE.test(body.startTime) || !TIME_RE.test(body.endTime)) {
      return res
        .status(400)
        .json(err("Formato de hora inválido (HH:MM)"));
    }
    if (body.startTime >= body.endTime) {
      return res
        .status(400)
        .json(err("La hora de inicio debe ser anterior a la de fin"));
    }
    startTime = body.startTime + ":00";
    endTime = body.endTime + ":00";
  } else {
    if (!body.startAt || !body.endAt) {
      return res
        .status(400)
        .json(err("Fechas requeridas para bloqueo puntual"));
    }
    const s = new Date(body.startAt);
    const e = new Date(body.endAt);
    if (isNaN(s.getTime()) || isNaN(e.getTime())) {
      return res.status(400).json(err("Fechas inválidas"));
    }
    if (s >= e) {
      return res
        .status(400)
        .json(err("La fecha de inicio debe ser anterior a la fin"));
    }
    startAt = s;
    endAt = e;
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("uId", sql.Int, req.user.userId)
      .input("name", sql.VarChar(LIMITS.NAME), name)
      .input("blockType", sql.VarChar(20), blockType)
      .input("daysOfWeek", sql.VarChar(30), daysOfWeek)
      .input("startTime", sql.VarChar(8), startTime)
      .input("endTime", sql.VarChar(8), endTime)
      .input("startAt", sql.DateTime2, startAt)
      .input("endAt", sql.DateTime2, endAt)
      .query(`
        INSERT INTO auth.user_blocks
          (user_id, name, block_type, days_of_week, start_time, end_time, start_at, end_at)
        OUTPUT INSERTED.block_id AS id
        VALUES (@uId, @name, @blockType, @daysOfWeek, @startTime, @endTime, @startAt, @endAt)
      `);
    return res.json(ok({ id: result.recordset[0].id }, "Bloqueo creado"));
  } catch (e) {
    console.error("[userBlock.create]", e);
    return res.status(500).json(err("No fue posible crear el bloqueo"));
  }
};

// PATCH /api/users/me/blocks/:id
const updateMyBlock = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no válido"));

  const body = req.body || {};

  try {
    const pool = await getPool();
    const check = await pool
      .request()
      .input("bId", sql.Int, id)
      .input("uId", sql.Int, req.user.userId)
      .query(
        `SELECT block_type FROM auth.user_blocks WHERE block_id = @bId AND user_id = @uId`
      );
    if (check.recordset.length === 0) {
      return res.status(404).json(err("Bloqueo no encontrado"));
    }
    const blockType = check.recordset[0].block_type;

    const sets = [];
    const request = pool.request().input("bId", sql.Int, id);

    if (body.name !== undefined) {
      const cleanName =
        typeof body.name === "string" ? body.name.trim() : "";
      if (!cleanName || cleanName.length > LIMITS.NAME) {
        return res.status(400).json(err("Nombre inválido"));
      }
      sets.push("name = @name");
      request.input("name", sql.VarChar(LIMITS.NAME), cleanName);
    }
    if (body.isActive !== undefined) {
      sets.push("is_active = @isActive");
      request.input("isActive", sql.Bit, body.isActive ? 1 : 0);
    }

    if (blockType === "recurring") {
      if (body.daysOfWeek !== undefined) {
        const normalized = normalizeDays(body.daysOfWeek);
        if (!DAYS_RE.test(normalized)) {
          return res.status(400).json(err("Días inválidos"));
        }
        sets.push("days_of_week = @daysOfWeek");
        request.input("daysOfWeek", sql.VarChar(30), normalized);
      }
      if (body.startTime !== undefined) {
        if (!TIME_RE.test(body.startTime)) {
          return res
            .status(400)
            .json(err("Formato de hora de inicio inválido"));
        }
        sets.push("start_time = @startTime");
        request.input("startTime", sql.VarChar(8), body.startTime + ":00");
      }
      if (body.endTime !== undefined) {
        if (!TIME_RE.test(body.endTime)) {
          return res
            .status(400)
            .json(err("Formato de hora de fin inválido"));
        }
        sets.push("end_time = @endTime");
        request.input("endTime", sql.VarChar(8), body.endTime + ":00");
      }
    } else {
      if (body.startAt !== undefined) {
        const s = new Date(body.startAt);
        if (isNaN(s.getTime())) {
          return res.status(400).json(err("Fecha de inicio inválida"));
        }
        sets.push("start_at = @startAt");
        request.input("startAt", sql.DateTime2, s);
      }
      if (body.endAt !== undefined) {
        const e = new Date(body.endAt);
        if (isNaN(e.getTime())) {
          return res.status(400).json(err("Fecha de fin inválida"));
        }
        sets.push("end_at = @endAt");
        request.input("endAt", sql.DateTime2, e);
      }
    }

    if (sets.length === 0) {
      return res.json(ok({}, "Sin cambios"));
    }

    await request.query(
      `UPDATE auth.user_blocks SET ${sets.join(", ")} WHERE block_id = @bId`
    );
    return res.json(ok({}, "Bloqueo actualizado"));
  } catch (e) {
    console.error("[userBlock.update]", e);
    return res.status(500).json(err("No fue posible actualizar el bloqueo"));
  }
};

// DELETE /api/users/me/blocks/:id
// Si tiene peticiones vinculadas (invitation_blocked_by_id), marca como inactivo
// para preservar la referencia. Si no, hace borrado físico.
const deleteMyBlock = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no válido"));

  try {
    const pool = await getPool();
    const check = await pool
      .request()
      .input("bId", sql.Int, id)
      .input("uId", sql.Int, req.user.userId)
      .query(
        `SELECT block_id FROM auth.user_blocks WHERE block_id = @bId AND user_id = @uId`
      );
    if (check.recordset.length === 0) {
      return res.status(404).json(err("Bloqueo no encontrado"));
    }

    const linked = await pool
      .request()
      .input("bId", sql.Int, id)
      .query(
        `SELECT COUNT(*) AS total FROM core.reservation_participants WHERE invitation_blocked_by_id = @bId`
      );

    if (linked.recordset[0].total > 0) {
      await pool
        .request()
        .input("bId", sql.Int, id)
        .query(
          `UPDATE auth.user_blocks SET is_active = 0 WHERE block_id = @bId`
        );
      return res.json(
        ok({}, "Bloqueo desactivado (tenía peticiones vinculadas)")
      );
    }

    await pool
      .request()
      .input("bId", sql.Int, id)
      .query(`DELETE FROM auth.user_blocks WHERE block_id = @bId`);
    return res.json(ok({}, "Bloqueo eliminado"));
  } catch (e) {
    console.error("[userBlock.delete]", e);
    return res.status(500).json(err("No fue posible eliminar el bloqueo"));
  }
};

module.exports = {
  listMyBlocks,
  createMyBlock,
  updateMyBlock,
  deleteMyBlock,
};
