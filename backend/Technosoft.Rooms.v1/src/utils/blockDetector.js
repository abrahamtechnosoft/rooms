const { getPool, sql } = require("../config/db");

/**
 * Para un set de userIds y un rango de fechas, devuelve qué usuarios tienen
 * bloqueos activos que se solapan con ese rango.
 *
 * - Bloqueos puntuales (one_time): comparación directa de DATETIME2.
 * - Bloqueos recurrentes (recurring): solo dispara si la reunión está dentro
 *   del MISMO día calendario y el día de la semana está en days_of_week (ISO:
 *   1=lunes...7=domingo) y las horas del día se solapan.
 *
 * Importante: `@@DATEFIRST` puede variar (US=7=domingo, ES=1=lunes). La
 * expresión `(((DATEPART(weekday, X) + @@DATEFIRST - 2) % 7) + 1)` normaliza
 * a ISO 8601 (1=lunes...7=domingo) independientemente del setting del server.
 *
 * Returns: Array<{ userId, blockId, blockName }>
 */
async function findBlocksInRange({
  userIds,
  startsAt,
  endsAt,
  pool: passedPool,
}) {
  if (!Array.isArray(userIds) || userIds.length === 0) return [];

  const cleanIds = [
    ...new Set(userIds.map(Number)),
  ].filter((n) => Number.isInteger(n) && n > 0);
  if (cleanIds.length === 0) return [];

  const pool = passedPool || (await getPool());
  const req = pool
    .request()
    .input("startsAt", sql.DateTime2, new Date(startsAt))
    .input("endsAt", sql.DateTime2, new Date(endsAt));

  const placeholders = cleanIds.map((_, i) => `@u${i}`).join(",");
  cleanIds.forEach((id, i) => req.input(`u${i}`, sql.Int, id));

  const result = await req.query(`
    SELECT DISTINCT
      b.user_id AS userId,
      b.block_id AS blockId,
      b.name AS blockName
    FROM auth.user_blocks b
    WHERE b.user_id IN (${placeholders})
      AND b.is_active = 1
      AND (
        -- Puntuales
        (
          b.block_type = 'one_time'
          AND b.start_at < @endsAt
          AND b.end_at   > @startsAt
        )
        OR
        -- Recurrentes (solo si la reunión cabe en un día calendario)
        (
          b.block_type = 'recurring'
          AND CAST(@startsAt AS DATE) = CAST(@endsAt AS DATE)
          AND (
            ',' + b.days_of_week + ','
            LIKE
            '%,' + CAST((((DATEPART(weekday, @startsAt) + @@DATEFIRST - 2) % 7) + 1) AS VARCHAR) + ',%'
          )
          AND CAST(@startsAt AS TIME) < b.end_time
          AND CAST(@endsAt   AS TIME) > b.start_time
        )
      )
  `);

  return result.recordset.map((r) => ({
    userId: r.userId,
    blockId: r.blockId,
    blockName: r.blockName,
  }));
}

module.exports = { findBlocksInRange };
