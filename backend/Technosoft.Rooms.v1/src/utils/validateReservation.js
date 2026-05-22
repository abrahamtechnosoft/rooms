const { sql } = require("../config/db");

const MIN_MINUTES = 15;
const MAX_MINUTES = 4 * 60;
const MAX_DAYS_AHEAD = 30;
const OPEN_HOUR = 8;
const CLOSE_HOUR = 17;

const toDate = (v) => (v instanceof Date ? v : new Date(v));

/**
 * Redondea una fecha al múltiplo de 5 minutos más cercano (sin segundos ni ms).
 * El backend acepta cualquier minuto en el input y normaliza aquí.
 */
function roundToNearest5Minutes(value) {
  const d = value instanceof Date ? new Date(value) : new Date(value);
  const minutes = d.getMinutes();
  const rounded = Math.round(minutes / 5) * 5;
  d.setMinutes(rounded);
  d.setSeconds(0);
  d.setMilliseconds(0);
  // Si el redondeo lleva a 60, sumar la hora.
  if (d.getMinutes() === 60) {
    d.setHours(d.getHours() + 1);
    d.setMinutes(0);
  }
  return d;
}

const validateReservation = async ({
  roomId,
  startsAt,
  endsAt,
  excludeId,
  pool,
  skipRoomOverlap = false,
  skipRoom = false,
}) => {
  const start = toDate(startsAt);
  const end = toDate(endsAt);

  if (isNaN(start) || isNaN(end)) {
    return { valid: false, msg: "Datos de la reserva incompletos" };
  }
  if (!skipRoom && !roomId) {
    return { valid: false, msg: "Datos de la reserva incompletos" };
  }

  if (start >= end) {
    return { valid: false, msg: "La hora de inicio debe ser anterior a la hora de fin" };
  }

  const now = new Date();
  if (start <= now) {
    return { valid: false, msg: "No se puede reservar en el pasado" };
  }

  const maxAhead = new Date(now.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000);
  if (start > maxAhead) {
    return { valid: false, msg: "Solo se permiten reservas hasta 30 dias a futuro" };
  }

  const durationMin = (end - start) / 60000;
  if (durationMin < MIN_MINUTES) {
    return {
      valid: false,
      msg: `La reunión debe durar al menos ${MIN_MINUTES} minutos`,
    };
  }
  if (durationMin > MAX_MINUTES) {
    return { valid: false, msg: "La duracion maxima es de 4 horas" };
  }

  const startHour = start.getHours();
  const startMin = start.getMinutes();
  const endHour = end.getHours();
  const endMin = end.getMinutes();

  if (startHour < OPEN_HOUR || startHour >= CLOSE_HOUR) {
    return { valid: false, msg: "Horario permitido: 08:00 a 17:00" };
  }
  if (endHour > CLOSE_HOUR || (endHour === CLOSE_HOUR && endMin > 0)) {
    return { valid: false, msg: "Horario permitido: 08:00 a 17:00" };
  }
  if (start.toDateString() !== end.toDateString()) {
    return { valid: false, msg: "La reserva debe iniciar y terminar el mismo dia" };
  }

  if (!skipRoomOverlap && !skipRoom) {
    // Considera ended_at cuando ended_early=1 (libera slot post-terminación).
    let query = `
      SELECT TOP 1 reservation_id
      FROM core.reservations
      WHERE room_id = @roomId
        AND status = 'active'
        AND starts_at < @endsAt
        AND (
          (ended_early = 1 AND ended_at > @startsAt)
          OR (ended_early = 0 AND ends_at > @startsAt)
        )
    `;
    const request = pool
      .request()
      .input("roomId", sql.Int, roomId)
      .input("startsAt", sql.DateTime2, start)
      .input("endsAt", sql.DateTime2, end);

    if (excludeId) {
      query += " AND reservation_id <> @excludeId";
      request.input("excludeId", sql.Int, excludeId);
    }

    const result = await request.query(query);
    if (result.recordset.length > 0) {
      return {
        valid: false,
        msg: "La sala ya tiene una reserva en ese horario",
      };
    }
  }

  return { valid: true, msg: "OK" };
};

module.exports = { validateReservation, roundToNearest5Minutes, MIN_MINUTES };
