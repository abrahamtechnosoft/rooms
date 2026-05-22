const { getPool, sql } = require("../config/db");

/**
 * Devuelve los user_ids que tienen una reserva activa solapada con el rango
 * dado. Considera tanto al creador como a los colaboradores.
 *
 * @param {object} args
 * @param {number[]} args.userIds         IDs de usuarios a chequear.
 * @param {Date|string} args.startsAt
 * @param {Date|string} args.endsAt
 * @param {number|null} args.excludeReservationId  Ignorar esta reserva (edicion).
 * @returns {Promise<number[]>}  IDs con solapamiento.
 */
async function findUsersWithOverlap({
  userIds,
  startsAt,
  endsAt,
  excludeReservationId = null,
  transaction = null,
}) {
  if (!userIds || userIds.length === 0) return [];

  const placeholders = userIds.map((_, i) => `@u${i}`).join(",");
  const req = transaction
    ? transaction.request()
    : (await getPool()).request();

  req
    .input("start", sql.DateTime2, new Date(startsAt))
    .input("end", sql.DateTime2, new Date(endsAt));
  userIds.forEach((id, i) => req.input(`u${i}`, sql.Int, id));
  if (excludeReservationId) {
    req.input("exclude", sql.Int, excludeReservationId);
  }

  // Si estamos dentro de una transaccion, agregar locks pesimistas para
  // impedir que otra transaccion lea/inserte un solapamiento en paralelo.
  const lockHint = transaction ? "WITH (UPDLOCK, HOLDLOCK)" : "";

  // Para reuniones terminadas antes (ended_early=1), el fin EFECTIVO es
  // ended_at, no ends_at. Eso libera el slot post-ended_at para otras.
  const query = `
    SELECT DISTINCT
      CASE
        WHEN r.created_by IN (${placeholders}) THEN r.created_by
        ELSE rp.user_id
      END AS user_id
    FROM core.reservations r ${lockHint}
    LEFT JOIN core.reservation_participants rp
      ON rp.reservation_id = r.reservation_id
      AND rp.status = 'active'
    WHERE r.status = 'active'
      AND r.starts_at < @end
      AND (
        (r.ended_early = 1 AND r.ended_at > @start)
        OR (r.ended_early = 0 AND r.ends_at > @start)
      )
      ${excludeReservationId ? "AND r.reservation_id <> @exclude" : ""}
      AND (
        r.created_by IN (${placeholders})
        OR rp.user_id IN (${placeholders})
      )
  `;

  const result = await req.query(query);
  return result.recordset.map((r) => r.user_id);
}

module.exports = { findUsersWithOverlap };
