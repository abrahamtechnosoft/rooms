const { getPool, sql } = require("../config/db");

/**
 * Inserta una entrada en core.reservation_history. Tolerante a fallos: si el
 * INSERT falla loguea por consola pero NO propaga el error para no romper el
 * flujo principal (la acción ya se persistió).
 *
 * Esquema esperado en core.reservation_history (recién creado):
 *   history_id, reservation_id, action_type, action_by, action_at, details
 */
async function logHistory({
  reservationId,
  actionType,
  actionBy,
  details = null,
  pool: poolArg,
}) {
  try {
    const pool = poolArg || (await getPool());
    const detailsStr =
      details == null
        ? null
        : typeof details === "string"
          ? details
          : JSON.stringify(details);
    await pool
      .request()
      .input("rId", sql.Int, reservationId)
      .input("actionType", sql.VarChar(40), actionType)
      .input("actionBy", sql.Int, actionBy)
      .input("details", sql.NVarChar(sql.MAX), detailsStr)
      .query(
        `INSERT INTO core.reservation_history
           (reservation_id, action_type, action_by, details)
         VALUES (@rId, @actionType, @actionBy, @details)`
      );
  } catch (e) {
    console.error("[logHistory]", e.message);
  }
}

module.exports = { logHistory };
