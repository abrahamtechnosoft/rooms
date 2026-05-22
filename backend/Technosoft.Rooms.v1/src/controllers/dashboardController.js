const { getPool, sql } = require("../config/db");
const { ok, err } = require("../utils/reply");

const MAX_JSON_BYTES = 16000;

const VALID_WIDGETS = new Set([
  "next-meeting",
  "rooms-status",
  "pinned",
  "notes",
  "reminders",
]);

function sanitizeOrder(input) {
  if (!Array.isArray(input)) return null;
  const seen = new Set();
  const result = [];
  for (const v of input) {
    if (typeof v === "string" && VALID_WIDGETS.has(v) && !seen.has(v)) {
      seen.add(v);
      result.push(v);
    }
  }
  return result.length > 0 ? result : null;
}

async function getLayout(req, res) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("userId", sql.Int, req.user.userId)
      .query(
        "SELECT layout_json FROM auth.user_dashboard_layout WHERE user_id = @userId"
      );
    if (result.recordset.length === 0) {
      return res.json(ok({ order: null }));
    }
    let parsed = null;
    try {
      parsed = JSON.parse(result.recordset[0].layout_json);
    } catch {
      parsed = null;
    }
    // Compatibilidad con layouts viejos (v1: array, v2/v3: {layout, calendarPct}).
    // Si no es el nuevo formato { order: [...] }, devolver null para que el
    // frontend caiga al default.
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.order)) {
      const cleaned = sanitizeOrder(parsed.order);
      return res.json(ok({ order: cleaned }));
    }
    return res.json(ok({ order: null }));
  } catch (e) {
    console.error("[dashboard.getLayout]", e);
    return res.status(500).json(err("No fue posible cargar el layout"));
  }
}

async function saveLayout(req, res) {
  try {
    const body = req.body || {};
    const cleaned = sanitizeOrder(body.order);
    if (!cleaned) {
      return res.status(400).json(err("Orden invalido"));
    }
    const json = JSON.stringify({ order: cleaned });
    if (Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
      return res.status(400).json(err("Payload demasiado grande"));
    }
    const pool = await getPool();
    await pool
      .request()
      .input("userId", sql.Int, req.user.userId)
      .input("json", sql.NVarChar(sql.MAX), json)
      .query(`
        MERGE auth.user_dashboard_layout AS target
        USING (SELECT @userId AS user_id) AS source
        ON target.user_id = source.user_id
        WHEN MATCHED THEN
          UPDATE SET layout_json = @json, updated_at = SYSDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (user_id, layout_json) VALUES (@userId, @json);
      `);
    return res.json(ok({}, "Orden guardado"));
  } catch (e) {
    console.error("[dashboard.saveLayout]", e);
    return res.status(500).json(err("No fue posible guardar el orden"));
  }
}

module.exports = { getLayout, saveLayout };
