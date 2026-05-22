const EXTERNAL_SUBTYPES = {
  CLIENT: 'client',
  EVENT: 'event',
  TRAINING: 'training',
  OTHER: 'other',
};

const EXTERNAL_SUBTYPE_LABELS = {
  client: 'Reunión con cliente',
  event: 'Evento / Conferencia',
  training: 'Capacitación externa',
  other: 'Otro',
};

const VALID_EXTERNAL_SUBTYPES = Object.values(EXTERNAL_SUBTYPES);

const VIRTUAL_PLATFORMS = ['meet', 'zoom', 'teams', 'other'];

module.exports = {
  EXTERNAL_SUBTYPES,
  EXTERNAL_SUBTYPE_LABELS,
  VALID_EXTERNAL_SUBTYPES,
  VIRTUAL_PLATFORMS,
};
