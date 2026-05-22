/**
 * Genera todas las fechas (startsAt, endsAt) de las instancias de una serie
 * recurrente según el patrón.
 *
 * Patterns soportados:
 *   - 'weekly' con frequencyWeeks (1, 2, 3, 4) y daysOfWeek ('1'..'7' ISO).
 *     'Todos los días' = pattern 'weekly' + daysOfWeek '1,2,3,4,5,6,7' + frequencyWeeks 1.
 *   - 'monthly' con dayOfMonth (1-31).
 *
 * @param {Object} params
 * @param {'weekly'|'monthly'} params.pattern
 * @param {string[]|null} params.daysOfWeek - ISO ('1'=lunes ... '7'=domingo). Requerido para weekly.
 * @param {number|null} params.frequencyWeeks - 1, 2, 3 o 4. Requerido para weekly.
 * @param {number|null} params.dayOfMonth - 1-31. Requerido para monthly.
 * @param {Date} params.startDate
 * @param {Date} params.endDate
 * @param {Date} params.startTime - Solo se usa hora/minuto.
 * @param {Date} params.endTime - Solo se usa hora/minuto.
 * @returns {Array<{ startsAt: Date, endsAt: Date }>}
 */
function generateOccurrences({
  pattern,
  daysOfWeek,
  frequencyWeeks,
  dayOfMonth,
  startDate,
  endDate,
  startTime,
  endTime,
}) {
  const occurrences = [];
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  const sh = startTime.getHours();
  const sm = startTime.getMinutes();
  const eh = endTime.getHours();
  const em = endTime.getMinutes();

  function pushAt(day) {
    const s = new Date(day);
    s.setHours(sh, sm, 0, 0);
    const e = new Date(day);
    e.setHours(eh, em, 0, 0);
    occurrences.push({ startsAt: s, endsAt: e });
  }

  if (pattern === "weekly") {
    if (!daysOfWeek || daysOfWeek.length === 0) {
      throw new Error("weekly requiere daysOfWeek");
    }
    if (!frequencyWeeks || ![1, 2, 3, 4].includes(frequencyWeeks)) {
      throw new Error("frequencyWeeks debe ser 1, 2, 3 o 4");
    }

    // ISO 1..7 (lun..dom) → JS getDay() 0..6 (dom..sáb). ISO 7 → JS 0.
    const jsDays = daysOfWeek.map((d) => {
      const n = parseInt(d, 10);
      return n === 7 ? 0 : n;
    });

    // Lunes (ISO) de la semana del startDate.
    const weekStart = new Date(start);
    const jsDayOfStart = weekStart.getDay();
    const daysToMonday = jsDayOfStart === 0 ? 6 : jsDayOfStart - 1;
    weekStart.setDate(weekStart.getDate() - daysToMonday);

    const current = new Date(weekStart);
    while (current <= end) {
      for (let i = 0; i < 7; i++) {
        const day = new Date(current);
        day.setDate(day.getDate() + i);
        if (day < start || day > end) continue;
        if (jsDays.includes(day.getDay())) pushAt(day);
      }
      current.setDate(current.getDate() + 7 * frequencyWeeks);
    }
  } else if (pattern === "monthly") {
    if (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) {
      throw new Error("monthly requiere dayOfMonth (1-31)");
    }
    let cy = start.getFullYear();
    let cm = start.getMonth();
    while (true) {
      const tentative = new Date(cy, cm, dayOfMonth);
      // Si el día se desbordó (ej. 31 en febrero), saltar mes.
      if (tentative.getMonth() !== cm) {
        cm++;
        if (cm > 11) {
          cm = 0;
          cy++;
        }
        if (new Date(cy, cm, 1) > end) break;
        continue;
      }
      if (tentative > end) break;
      if (tentative >= start) pushAt(tentative);
      cm++;
      if (cm > 11) {
        cm = 0;
        cy++;
      }
    }
  } else {
    throw new Error(
      `Pattern no soportado: ${pattern}. Solo 'weekly' y 'monthly'.`
    );
  }

  occurrences.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return occurrences;
}

module.exports = { generateOccurrences };
