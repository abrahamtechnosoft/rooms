const RESERVATION_TYPES = {
  PHYSICAL: "physical",
  VIRTUAL: "virtual",
  EXTERNAL: "external",
  OFFICE: "office",
};

const VALID_TYPES = Object.values(RESERVATION_TYPES);

module.exports = { RESERVATION_TYPES, VALID_TYPES };
