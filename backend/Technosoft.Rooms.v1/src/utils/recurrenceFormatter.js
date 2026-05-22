const DAY_NAMES = {
  "1": "Lunes",
  "2": "Martes",
  "3": "Miércoles",
  "4": "Jueves",
  "5": "Viernes",
  "6": "Sábado",
  "7": "Domingo",
};

/**
 * Describe la recurrencia en lenguaje natural.
 *
 * @param {Object} params
 * @param {'weekly'|'monthly'} params.pattern
 * @param {string|null} params.daysOfWeek - '1,2,3,4,5' ISO. Solo para weekly.
 * @param {number|null} params.frequencyWeeks - 1, 2, 3 o 4. Solo para weekly.
 * @param {number|null} params.dayOfMonth - 1-31. Solo para monthly.
 * @returns {string}
 */
function formatRecurrenceDescription({
  pattern,
  daysOfWeek,
  frequencyWeeks,
  dayOfMonth,
}) {
  if (pattern === "monthly") {
    return `Mensual, día ${dayOfMonth}`;
  }

  if (pattern === "weekly") {
    const days = (daysOfWeek || "")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean)
      .sort();
    const labels = days
      .map((d) => DAY_NAMES[d])
      .filter(Boolean)
      .join(", ");
    const freq = frequencyWeeks || 1;

    if (days.length === 7) {
      return freq === 1
        ? "Todos los días"
        : `Todos los días, cada ${freq} semanas`;
    }
    if (days.length === 5 && days.join(",") === "1,2,3,4,5") {
      return freq === 1
        ? "Días hábiles (L-V)"
        : `Días hábiles (L-V), cada ${freq} semanas`;
    }
    if (days.length === 2 && days.join(",") === "6,7") {
      return freq === 1
        ? "Fines de semana"
        : `Fines de semana, cada ${freq} semanas`;
    }
    if (freq === 1) return `Semanal: ${labels}`;
    return `Cada ${freq} semanas: ${labels}`;
  }

  return "Recurrente";
}

module.exports = { formatRecurrenceDescription };
