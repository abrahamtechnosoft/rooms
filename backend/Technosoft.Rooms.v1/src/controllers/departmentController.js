const { getPool, sql } = require("../config/db");
const { ok, err } = require("../utils/reply");

const LIMITS = {
  NAME: 60,
  DESCRIPTION: 200,
  COLOR: 20,
};

function mapDepartment(d) {
  return {
    id: d.department_id,
    name: d.name,
    description: d.description || null,
    colorHex: d.color_hex || null,
    isActive: !!d.is_active,
    createdAt: d.created_at,
    memberCount:
      typeof d.member_count === "number" ? d.member_count : undefined,
  };
}

async function listDepartments(req, res) {
  try {
    const includeInactive = String(req.query.includeInactive || "") === "true";
    const where = includeInactive ? "" : "WHERE d.is_active = 1";

    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        d.department_id,
        d.name,
        d.description,
        d.color_hex,
        d.is_active,
        d.created_at,
        (
          SELECT COUNT(*)
          FROM auth.users u
          WHERE u.department_id = d.department_id AND u.is_active = 1
        ) AS member_count
      FROM auth.departments d
      ${where}
      ORDER BY d.name
    `);

    return res.json(ok(result.recordset.map(mapDepartment), "OK"));
  } catch (e) {
    console.error("[departments.list]", e);
    return res
      .status(500)
      .json(err("No fue posible cargar los departamentos"));
  }
}

async function createDepartment(req, res) {
  if (req.user.role !== "admin") {
    return res.status(403).json(err("Sin permisos"));
  }

  const name = String(req.body.name || "").trim();
  const description =
    req.body.description != null ? String(req.body.description).trim() : null;
  const colorHex =
    req.body.colorHex != null ? String(req.body.colorHex).trim() : null;

  if (name.length < 1 || name.length > LIMITS.NAME) {
    return res
      .status(400)
      .json(err(`El nombre debe tener entre 1 y ${LIMITS.NAME} caracteres`));
  }
  if (description && description.length > LIMITS.DESCRIPTION) {
    return res
      .status(400)
      .json(
        err(`La descripción no puede superar ${LIMITS.DESCRIPTION} caracteres`)
      );
  }
  if (colorHex && colorHex.length > LIMITS.COLOR) {
    return res.status(400).json(err("Color inválido"));
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("name", sql.VarChar(LIMITS.NAME), name)
      .input("description", sql.VarChar(LIMITS.DESCRIPTION), description || null)
      .input("colorHex", sql.VarChar(LIMITS.COLOR), colorHex || null)
      .query(`
        INSERT INTO auth.departments (name, description, color_hex, is_active)
        OUTPUT INSERTED.department_id
        VALUES (@name, @description, @colorHex, 1)
      `);
    return res
      .status(201)
      .json(
        ok({ id: result.recordset[0].department_id }, "Departamento creado")
      );
  } catch (e) {
    if (e.number === 2627 || e.number === 2601) {
      return res
        .status(409)
        .json(err("Ya existe un departamento con ese nombre"));
    }
    console.error("[departments.create]", e);
    return res.status(500).json(err("No fue posible crear el departamento"));
  }
}

async function updateDepartment(req, res) {
  if (req.user.role !== "admin") {
    return res.status(403).json(err("Sin permisos"));
  }

  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json(err("Identificador no válido"));
  }

  const name = String(req.body.name || "").trim();
  const description =
    req.body.description != null ? String(req.body.description).trim() : null;
  const colorHex =
    req.body.colorHex != null ? String(req.body.colorHex).trim() : null;
  const isActive = req.body.isActive === false ? 0 : 1;

  if (name.length < 1 || name.length > LIMITS.NAME) {
    return res
      .status(400)
      .json(err(`El nombre debe tener entre 1 y ${LIMITS.NAME} caracteres`));
  }
  if (description && description.length > LIMITS.DESCRIPTION) {
    return res
      .status(400)
      .json(
        err(`La descripción no puede superar ${LIMITS.DESCRIPTION} caracteres`)
      );
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .input("name", sql.VarChar(LIMITS.NAME), name)
      .input("description", sql.VarChar(LIMITS.DESCRIPTION), description || null)
      .input("colorHex", sql.VarChar(LIMITS.COLOR), colorHex || null)
      .input("isActive", sql.Bit, isActive)
      .query(`
        UPDATE auth.departments
        SET name = @name,
            description = @description,
            color_hex = @colorHex,
            is_active = @isActive
        OUTPUT INSERTED.department_id
        WHERE department_id = @id
      `);

    if (result.recordset.length === 0) {
      return res.status(404).json(err("Departamento no encontrado"));
    }

    return res.json(ok({ id }, "Departamento actualizado"));
  } catch (e) {
    if (e.number === 2627 || e.number === 2601) {
      return res
        .status(409)
        .json(err("Ya existe un departamento con ese nombre"));
    }
    console.error("[departments.update]", e);
    return res
      .status(500)
      .json(err("No fue posible actualizar el departamento"));
  }
}

async function getDepartmentMembers(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json(err("Identificador no válido"));
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        SELECT
          u.user_id    AS id,
          u.full_name  AS fullName,
          u.email,
          u.avatar_url AS avatarUrl
        FROM auth.users u
        WHERE u.department_id = @id AND u.is_active = 1
        ORDER BY u.full_name, u.email
      `);
    return res.json(ok(result.recordset, "OK"));
  } catch (e) {
    console.error("[departments.members]", e);
    return res
      .status(500)
      .json(err("No fue posible cargar los miembros del departamento"));
  }
}

module.exports = {
  listDepartments,
  createDepartment,
  updateDepartment,
  getDepartmentMembers,
};
