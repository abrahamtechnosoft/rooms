const { getPool, sql } = require("../config/db");
const { ok, err } = require("../utils/reply");

// Límites de longitud (mantener sincronizados con el frontend).
const LIMITS = {
  NAME: 40,
  DESCRIPTION: 200,
  LOCATION: 100,
};

const VALID_ICONS = [
  "Building2",
  "Briefcase",
  "Video",
  "Users",
  "Coffee",
  "Wifi",
  "Monitor",
  "Mic",
  "Presentation",
  "Lightbulb",
  "Headphones",
  "BookOpen",
  "Pen",
  "Calendar",
  "Globe",
  "Home",
  "MapPin",
  "MessageSquare",
  "Smartphone",
  "Star",
];

const isHexColor = (v) => /^#[0-9A-Fa-f]{6}$/.test(v);

const mapRoom = (r) => ({
  id: r.room_id,
  name: r.name,
  capacity: r.capacity,
  location: r.location,
  isActive: !!r.is_active,
  colorHex: r.color_hex || null,
  iconName: r.icon_name || null,
  description: r.description || null,
  createdAt: r.created_at,
});

const SELECT_ROOM_FIELDS = `
  room_id, name, capacity, location, is_active,
  color_hex, icon_name, description, created_at
`;

const getAll = async (req, res) => {
  // Por defecto se excluyen las salas inactivas. El admin puede pedir todo
  // con ?includeInactive=true para gestionarlas desde /dashboard/rooms.
  const includeInactive =
    req.query &&
    req.query.includeInactive === "true" &&
    req.user &&
    req.user.role === "admin";
  const where = includeInactive ? "" : "WHERE is_active = 1";
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT ${SELECT_ROOM_FIELDS}
      FROM core.rooms
      ${where}
      ORDER BY name ASC
    `);
    return res.json(ok(result.recordset.map(mapRoom)));
  } catch (e) {
    console.error("[room.getAll]", e);
    return res.status(500).json(err("No fue posible obtener las salas"));
  }
};

const getById = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        SELECT ${SELECT_ROOM_FIELDS}
        FROM core.rooms WHERE room_id = @id
      `);
    if (result.recordset.length === 0) {
      return res.status(404).json(err("Sala no encontrada"));
    }
    return res.json(ok(mapRoom(result.recordset[0])));
  } catch (e) {
    console.error("[room.getById]", e);
    return res.status(500).json(err("No fue posible obtener la sala"));
  }
};

const create = async (req, res) => {
  const {
    name,
    capacity,
    location,
    colorHex,
    iconName,
    description,
    isActive,
  } = req.body || {};

  if (!name || !String(name).trim()) {
    return res.status(400).json(err("El nombre es requerido"));
  }
  if (String(name).trim().length > LIMITS.NAME) {
    return res
      .status(400)
      .json(err(`El nombre no puede superar ${LIMITS.NAME} caracteres`));
  }

  const parsedCapacity = capacity != null ? parseInt(capacity, 10) : NaN;
  if (!Number.isInteger(parsedCapacity) || parsedCapacity < 1) {
    return res.status(400).json(err("La capacidad es requerida"));
  }

  if (colorHex != null && colorHex !== "" && !isHexColor(colorHex)) {
    return res.status(400).json(err("Color invalido"));
  }
  if (iconName != null && iconName !== "" && !VALID_ICONS.includes(iconName)) {
    return res.status(400).json(err("Icono invalido"));
  }
  const cleanColor = colorHex && colorHex !== "" ? colorHex : null;
  const cleanIcon = iconName && iconName !== "" ? iconName : null;
  const cleanDesc =
    description != null && String(description).trim() !== ""
      ? String(description).trim().slice(0, LIMITS.DESCRIPTION)
      : null;
  const cleanLocation =
    location != null && String(location).trim() !== ""
      ? String(location).trim()
      : null;

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("name", sql.VarChar(80), String(name).trim())
      .input("capacity", sql.Int, parsedCapacity)
      .input("location", sql.VarChar(150), cleanLocation)
      .input("is_active", sql.Bit, isActive === false ? 0 : 1)
      .input("color_hex", sql.VarChar(20), cleanColor)
      .input("icon_name", sql.VarChar(50), cleanIcon)
      .input("description", sql.VarChar(500), cleanDesc)
      .query(`
        INSERT INTO core.rooms
          (name, capacity, location, is_active, color_hex, icon_name, description)
        OUTPUT ${SELECT_ROOM_FIELDS.split(",").map((c) => `inserted.${c.trim()}`).join(", ")}
        VALUES (@name, @capacity, @location, @is_active, @color_hex, @icon_name, @description)
      `);
    return res
      .status(201)
      .json(ok(mapRoom(result.recordset[0]), "Sala creada"));
  } catch (e) {
    console.error("[room.create]", e);
    return res.status(500).json(err("No fue posible crear la sala"));
  }
};

const update = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  const {
    name,
    capacity,
    location,
    isActive,
    colorHex,
    iconName,
    description,
  } = req.body || {};

  if (name != null && !String(name).trim()) {
    return res.status(400).json(err("El nombre es requerido"));
  }
  if (name != null && String(name).trim().length > LIMITS.NAME) {
    return res
      .status(400)
      .json(err(`El nombre no puede superar ${LIMITS.NAME} caracteres`));
  }
  if (colorHex != null && colorHex !== "" && !isHexColor(colorHex)) {
    return res.status(400).json(err("Color invalido"));
  }
  if (iconName != null && iconName !== "" && !VALID_ICONS.includes(iconName)) {
    return res.status(400).json(err("Icono invalido"));
  }

  // null = no tocar (CASE WHEN @x IS NULL THEN col ELSE @x)
  const colorParam = colorHex == null ? null : colorHex === "" ? "" : colorHex;
  const iconParam = iconName == null ? null : iconName === "" ? "" : iconName;
  const descParam =
    description == null
      ? null
      : String(description).trim().slice(0, LIMITS.DESCRIPTION);
  const locationParam =
    location == null ? null : String(location).trim();

  try {
    const pool = await getPool();
    const request = pool
      .request()
      .input("id", sql.Int, id)
      .input("name", sql.VarChar(80), name != null ? String(name).trim() : null)
      .input(
        "capacity",
        sql.Int,
        capacity != null ? parseInt(capacity, 10) : null
      )
      .input("location", sql.VarChar(150), locationParam)
      .input("is_active", sql.Bit, isActive != null ? (isActive ? 1 : 0) : null)
      .input("color_hex", sql.VarChar(20), colorParam)
      .input("icon_name", sql.VarChar(50), iconParam)
      .input("description", sql.VarChar(500), descParam);

    const result = await request.query(`
      UPDATE core.rooms SET
        name        = ISNULL(@name, name),
        capacity    = ISNULL(@capacity, capacity),
        location    = CASE WHEN @location IS NULL THEN location
                           WHEN @location = '' THEN NULL
                           ELSE @location END,
        is_active   = ISNULL(@is_active, is_active),
        color_hex   = CASE WHEN @color_hex IS NULL THEN color_hex
                           WHEN @color_hex = '' THEN NULL
                           ELSE @color_hex END,
        icon_name   = CASE WHEN @icon_name IS NULL THEN icon_name
                           WHEN @icon_name = '' THEN NULL
                           ELSE @icon_name END,
        description = CASE WHEN @description IS NULL THEN description
                           WHEN @description = '' THEN NULL
                           ELSE @description END
      OUTPUT ${SELECT_ROOM_FIELDS.split(",").map((c) => `inserted.${c.trim()}`).join(", ")}
      WHERE room_id = @id
    `);

    if (result.recordset.length === 0) {
      return res.status(404).json(err("Sala no encontrada"));
    }
    return res.json(ok(mapRoom(result.recordset[0]), "Sala actualizada"));
  } catch (e) {
    console.error("[room.update]", e);
    return res.status(500).json(err("No fue posible actualizar la sala"));
  }
};

// GET /rooms/:id/availability?date=YYYY-MM-DD&excludeReservationId=
// Devuelve los rangos ocupados (status='active') de una sala física en una
// fecha. Considera `ended_early`/`ended_at` como fin efectivo. Permite excluir
// una reservación (típicamente la que se está editando) para evitar que el
// propio bloque aparezca como conflicto contra sí mismo.
const getAvailability = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));

  const date = req.query && typeof req.query.date === "string" ? req.query.date : null;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json(err("Fecha invalida"));
  }

  const excludeId =
    req.query && req.query.excludeReservationId
      ? parseInt(req.query.excludeReservationId, 10)
      : null;

  // Rango del día en hora local del servidor (00:00 — 24:00).
  const [y, mo, d] = date.split("-").map((v) => parseInt(v, 10));
  const dayStart = new Date(y, (mo || 1) - 1, d || 1, 0, 0, 0, 0);
  const dayEnd = new Date(y, (mo || 1) - 1, d || 1, 24, 0, 0, 0);

  try {
    const pool = await getPool();
    const request = pool
      .request()
      .input("roomId", sql.Int, id)
      .input("dayStart", sql.DateTime2, dayStart)
      .input("dayEnd", sql.DateTime2, dayEnd);
    if (excludeId && Number.isInteger(excludeId)) {
      request.input("excludeId", sql.Int, excludeId);
    }

    const result = await request.query(`
      SELECT
        reservation_id   AS reservationId,
        starts_at        AS startsAt,
        ends_at          AS endsAt,
        ended_early      AS endedEarly,
        ended_at         AS endedAt
      FROM core.reservations
      WHERE room_id = @roomId
        AND status = 'active'
        AND starts_at < @dayEnd
        AND (
          (ended_early = 1 AND ended_at > @dayStart)
          OR (ended_early = 0 AND ends_at > @dayStart)
        )
        ${excludeId && Number.isInteger(excludeId) ? "AND reservation_id <> @excludeId" : ""}
      ORDER BY starts_at ASC
    `);

    const ranges = result.recordset.map((r) => ({
      reservationId: r.reservationId,
      startsAt: r.startsAt,
      endsAt: r.endedEarly && r.endedAt ? r.endedAt : r.endsAt,
    }));

    return res.json(ok({ date, roomId: id, ranges }));
  } catch (e) {
    console.error("[room.getAvailability]", e);
    return res
      .status(500)
      .json(err("No fue posible obtener la disponibilidad de la sala"));
  }
};

const softDelete = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        UPDATE core.rooms SET is_active = 0
        OUTPUT inserted.room_id
        WHERE room_id = @id
      `);
    if (result.recordset.length === 0) {
      return res.status(404).json(err("Sala no encontrada"));
    }
    return res.json(ok({ id }, "Sala desactivada"));
  } catch (e) {
    console.error("[room.softDelete]", e);
    return res.status(500).json(err("No fue posible desactivar la sala"));
  }
};

module.exports = { getAll, getById, create, update, softDelete, getAvailability };
