const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('../config/db');
const { ok, err } = require('../utils/reply');
const { sendLoginCode } = require('../services/mailer');

const CODE_TTL_MIN = parseInt(process.env.LOGIN_CODE_TTL_MINUTES || '10', 10);
const MAX_ATTEMPTS = parseInt(process.env.LOGIN_CODE_MAX_ATTEMPTS || '5', 10);

function hashCode(plainCode) {
  return crypto.createHash('sha256').update(plainCode).digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function requestCode(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email) {
    return res.status(400).json(err('Correo no valido'));
  }

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('email', sql.VarChar(150), email)
      .query(
        'SELECT user_id, full_name FROM auth.users WHERE email = @email AND is_active = 1'
      );

    if (result.recordset.length === 0) {
      console.log(`[auth] Solicitud de codigo para email no registrado: ${email}`);
      return res.json(
        ok({ sent: true }, 'Si el correo esta registrado, recibira un codigo')
      );
    }

    const user = result.recordset[0];

    const code = generateCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60_000);

    await pool
      .request()
      .input('userId', sql.Int, user.user_id)
      .input('codeHash', sql.VarChar(255), codeHash)
      .input('expiresAt', sql.DateTime2, expiresAt)
      .input('ipAddress', sql.VarChar(45), req.ip || null)
      .query(
        `INSERT INTO auth.login_codes (user_id, code_hash, expires_at, ip_address)
         VALUES (@userId, @codeHash, @expiresAt, @ipAddress)`
      );

    await sendLoginCode(email, user.full_name, code);

    return res.json(ok({ sent: true }, 'Codigo enviado al correo'));
  } catch (e) {
    console.error('[auth.requestCode]', e);
    return res.status(500).json(err('No fue posible enviar el codigo'));
  }
}

async function verifyCode(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();

  if (!email || !/^\d{6}$/.test(code)) {
    return res.status(400).json(err('Correo o codigo no valido'));
  }

  try {
    const pool = await getPool();

    const userRes = await pool
      .request()
      .input('email', sql.VarChar(150), email)
      .query(
        'SELECT user_id, email, full_name, role, avatar_url FROM auth.users WHERE email = @email AND is_active = 1'
      );

    if (userRes.recordset.length === 0) {
      return res.status(401).json(err('Codigo no valido o vencido'));
    }
    const user = userRes.recordset[0];

    const codeHash = hashCode(code);
    const codeRes = await pool
      .request()
      .input('userId', sql.Int, user.user_id)
      .query(
        `SELECT TOP 1 login_code_id, code_hash, expires_at, attempts
         FROM auth.login_codes
         WHERE user_id = @userId AND used_at IS NULL
         ORDER BY created_at DESC`
      );

    if (codeRes.recordset.length === 0) {
      return res.status(401).json(err('Codigo no valido o vencido'));
    }
    const stored = codeRes.recordset[0];

    if (new Date(stored.expires_at) < new Date()) {
      return res.status(401).json(err('Codigo no valido o vencido'));
    }

    if (stored.attempts >= MAX_ATTEMPTS) {
      return res
        .status(401)
        .json(err('Demasiados intentos. Solicite un codigo nuevo.'));
    }

    if (stored.code_hash !== codeHash) {
      await pool
        .request()
        .input('id', sql.Int, stored.login_code_id)
        .query(
          'UPDATE auth.login_codes SET attempts = attempts + 1 WHERE login_code_id = @id'
        );
      return res.status(401).json(err('Codigo no valido o vencido'));
    }

    await pool
      .request()
      .input('id', sql.Int, stored.login_code_id)
      .query(
        'UPDATE auth.login_codes SET used_at = SYSDATETIME() WHERE login_code_id = @id'
      );

    const token = jwt.sign(
      { userId: user.user_id, role: user.role, fullName: user.full_name },
      process.env.JWT_SECRET
      // sin expiresIn: la sesion no expira automaticamente
    );

    return res.json(
      ok(
        {
          token,
          user: {
            id: user.user_id,
            email: user.email,
            fullName: user.full_name,
            role: user.role,
            avatarUrl: user.avatar_url,
          },
        },
        'Acceso autorizado'
      )
    );
  } catch (e) {
    console.error('[auth.verifyCode]', e);
    return res.status(500).json(err('No fue posible verificar el codigo'));
  }
}

async function me(req, res) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('userId', sql.Int, req.user.userId)
      .query(`
        SELECT
          u.user_id,
          u.email,
          u.full_name,
          u.role,
          u.avatar_url,
          u.avatar_prompt_seen,
          u.department_id,
          d.name        AS department_name,
          d.color_hex   AS department_color,
          d.office_name AS office_name
        FROM auth.users u
        LEFT JOIN auth.departments d ON d.department_id = u.department_id
        WHERE u.user_id = @userId AND u.is_active = 1
      `);

    if (result.recordset.length === 0) {
      return res.status(401).json(err('Sesion no valida'));
    }

    const u = result.recordset[0];
    return res.json(
      ok(
        {
          id: u.user_id,
          email: u.email,
          fullName: u.full_name,
          role: u.role,
          avatarUrl: u.avatar_url,
          avatarPromptSeen:
            u.avatar_prompt_seen === true || u.avatar_prompt_seen === 1,
          departmentId: u.department_id != null ? u.department_id : null,
          departmentName: u.department_name || null,
          departmentColor: u.department_color || null,
          officeName: u.office_name || null,
        },
        'OK'
      )
    );
  } catch (e) {
    console.error('[auth.me]', e);
    return res.status(500).json(err('No fue posible cargar el perfil'));
  }
}

async function updateMe(req, res) {
  const hasFullName = Object.prototype.hasOwnProperty.call(
    req.body || {},
    'fullName'
  );
  const hasDepartmentId = Object.prototype.hasOwnProperty.call(
    req.body || {},
    'departmentId'
  );

  if (!hasFullName && !hasDepartmentId) {
    return res.status(400).json(err('No hay cambios para guardar'));
  }

  const fullName = hasFullName ? String(req.body.fullName || '').trim() : null;
  if (hasFullName && (fullName.length < 2 || fullName.length > 150)) {
    return res
      .status(400)
      .json(err('El nombre debe tener entre 2 y 150 caracteres'));
  }

  let departmentId = null;
  if (hasDepartmentId) {
    const raw = req.body.departmentId;
    if (raw === null || raw === '' || raw === undefined) {
      departmentId = null;
    } else {
      const parsed = parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return res.status(400).json(err('Departamento inválido'));
      }
      departmentId = parsed;
    }
  }

  try {
    const pool = await getPool();

    // Lockdown: si el usuario YA tiene departamento, no puede cambiarlo a otro
    // ni quitarlo desde su perfil. Solo un administrador puede modificarlo
    // (vía PATCH /users/:id/department).
    if (hasDepartmentId) {
      const currentRes = await pool
        .request()
        .input('userId', sql.Int, req.user.userId)
        .query('SELECT department_id FROM auth.users WHERE user_id = @userId');
      const currentDeptId =
        currentRes.recordset[0]?.department_id != null
          ? currentRes.recordset[0].department_id
          : null;
      if (currentDeptId !== null && departmentId !== currentDeptId) {
        return res
          .status(403)
          .json(
            err(
              'Solo puedes elegir tu departamento una vez. Pídele al administrador que lo cambie.'
            )
          );
      }
    }

    if (hasDepartmentId && departmentId !== null) {
      const dept = await pool
        .request()
        .input('id', sql.Int, departmentId)
        .query(
          'SELECT 1 FROM auth.departments WHERE department_id = @id AND is_active = 1'
        );
      if (dept.recordset.length === 0) {
        return res.status(400).json(err('Departamento inválido'));
      }
    }

    const setClauses = [];
    const request = pool.request().input('userId', sql.Int, req.user.userId);
    if (hasFullName) {
      setClauses.push('full_name = @fullName');
      request.input('fullName', sql.VarChar(150), fullName);
    }
    if (hasDepartmentId) {
      setClauses.push('department_id = @departmentId');
      request.input('departmentId', sql.Int, departmentId);
    }

    await request.query(
      `UPDATE auth.users SET ${setClauses.join(', ')} WHERE user_id = @userId`
    );

    return res.json(ok({}, 'Perfil actualizado'));
  } catch (e) {
    console.error('[auth.updateMe]', e);
    return res.status(500).json(err('No fue posible actualizar el perfil'));
  }
}

module.exports = { requestCode, verifyCode, me, updateMe };
