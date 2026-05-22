const fs = require('fs');
const path = require('path');
const { getPool, sql } = require('../config/db');
const { ok, err } = require('../utils/reply');

// Límites de longitud (mantener sincronizados con el frontend).
const LIMITS = {
  FULL_NAME: 80,
};

const AVATAR_DIR = path.join(__dirname, '..', '..', 'uploads', 'avatars');
const AVATAR_EXTS = ['jpg', 'png', 'webp'];

function removeExistingAvatars(userId) {
  AVATAR_EXTS.forEach((e) => {
    const p = path.join(AVATAR_DIR, `${userId}.${e}`);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch (_) {
        // ignorar errores de borrado de archivos huerfanos
      }
    }
  });
}

async function picker(req, res) {
  const raw = String(req.query.q || '').trim();
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('q', sql.NVarChar(150), `%${raw}%`)
      .query(`
        SELECT TOP 50
          user_id     AS id,
          email,
          full_name   AS fullName,
          avatar_url  AS avatarUrl
        FROM auth.users
        WHERE is_active = 1
          AND (
            full_name COLLATE Latin1_General_CI_AI LIKE @q COLLATE Latin1_General_CI_AI
            OR email   COLLATE Latin1_General_CI_AI LIKE @q COLLATE Latin1_General_CI_AI
          )
        ORDER BY full_name, email
      `);
    return res.json(ok(result.recordset, 'OK'));
  } catch (e) {
    console.error('[users.picker]', e);
    return res.status(500).json(err('No fue posible cargar los usuarios'));
  }
}

async function listUsers(req, res) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        u.user_id,
        u.email,
        u.full_name,
        u.role,
        u.is_active,
        u.created_at,
        u.avatar_url,
        u.department_id,
        d.name      AS department_name,
        d.color_hex AS department_color
      FROM auth.users u
      LEFT JOIN auth.departments d ON d.department_id = u.department_id
      ORDER BY u.full_name
    `);
    const users = result.recordset.map((u) => ({
      id: u.user_id,
      email: u.email,
      fullName: u.full_name,
      role: u.role,
      isActive: !!u.is_active,
      createdAt: u.created_at,
      avatarUrl: u.avatar_url,
      departmentId: u.department_id != null ? u.department_id : null,
      departmentName: u.department_name || null,
      departmentColor: u.department_color || null,
    }));
    return res.json(ok(users, 'OK'));
  } catch (e) {
    console.error('[users.list]', e);
    return res.status(500).json(err('No fue posible cargar los usuarios'));
  }
}

async function createUser(req, res) {
  const email = String(req.body.email || '').trim().toLowerCase();
  const fullName = String(req.body.fullName || '').trim();
  const role = String(req.body.role || 'empleado').trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json(err('Correo no valido'));
  }
  if (fullName.length < 2 || fullName.length > LIMITS.FULL_NAME) {
    return res
      .status(400)
      .json(
        err(`El nombre debe tener entre 2 y ${LIMITS.FULL_NAME} caracteres`)
      );
  }
  if (!['admin', 'empleado'].includes(role)) {
    return res.status(400).json(err('Rol no valido'));
  }

  try {
    const pool = await getPool();

    const dup = await pool
      .request()
      .input('email', sql.VarChar(150), email)
      .query('SELECT 1 FROM auth.users WHERE email = @email');
    if (dup.recordset.length > 0) {
      return res.status(409).json(err('Ya existe un usuario con ese correo'));
    }

    const result = await pool
      .request()
      .input('email', sql.VarChar(150), email)
      .input('fullName', sql.VarChar(150), fullName)
      .input('role', sql.VarChar(20), role)
      .query(
        `INSERT INTO auth.users (email, full_name, role, is_active)
         OUTPUT INSERTED.user_id
         VALUES (@email, @fullName, @role, 1)`
      );

    return res.json(
      ok(
        {
          id: result.recordset[0].user_id,
          email,
          fullName,
          role,
          isActive: true,
        },
        'Usuario creado'
      )
    );
  } catch (e) {
    console.error('[users.create]', e);
    return res.status(500).json(err('No fue posible crear el usuario'));
  }
}

async function setActive(req, res) {
  const id = parseInt(req.params.id, 10);
  const active = req.body.isActive === true || req.body.isActive === 'true';
  if (!id) return res.status(400).json(err('Identificador no valido'));

  try {
    const pool = await getPool();
    await pool
      .request()
      .input('id', sql.Int, id)
      .input('active', sql.Bit, active ? 1 : 0)
      .query('UPDATE auth.users SET is_active = @active WHERE user_id = @id');
    return res.json(ok({ id, isActive: active }, 'Usuario actualizado'));
  } catch (e) {
    console.error('[users.setActive]', e);
    return res.status(500).json(err('No fue posible actualizar el usuario'));
  }
}

async function updateUser(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err('Identificador no valido'));

  const hasFullName = Object.prototype.hasOwnProperty.call(req.body, 'fullName');
  const hasRole = Object.prototype.hasOwnProperty.call(req.body, 'role');

  if (!hasFullName && !hasRole) {
    return res.status(400).json(err('No hay cambios para guardar'));
  }

  const fullName = hasFullName ? String(req.body.fullName || '').trim() : null;
  const role = hasRole ? String(req.body.role || '').trim() : null;

  if (hasFullName && (fullName.length < 2 || fullName.length > LIMITS.FULL_NAME)) {
    return res
      .status(400)
      .json(
        err(`El nombre debe tener entre 2 y ${LIMITS.FULL_NAME} caracteres`)
      );
  }
  if (hasRole && !['admin', 'empleado'].includes(role)) {
    return res.status(400).json(err('Rol no valido'));
  }

  try {
    const pool = await getPool();

    const current = await pool
      .request()
      .input('id', sql.Int, id)
      .query(
        `SELECT user_id, email, full_name, role, is_active
         FROM auth.users WHERE user_id = @id`
      );
    if (current.recordset.length === 0) {
      return res.status(404).json(err('Usuario no encontrado'));
    }
    const target = current.recordset[0];

    if (
      hasRole &&
      target.role === 'admin' &&
      role === 'empleado' &&
      target.is_active
    ) {
      const otros = await pool
        .request()
        .input('id', sql.Int, id)
        .query(
          `SELECT COUNT(*) AS n FROM auth.users
           WHERE role = 'admin' AND is_active = 1 AND user_id <> @id`
        );
      if ((otros.recordset[0]?.n || 0) === 0) {
        return res
          .status(400)
          .json(
            err('No se puede cambiar el rol del unico administrador activo')
          );
      }
    }

    const setClauses = [];
    const request = pool.request().input('id', sql.Int, id);
    if (hasFullName) {
      setClauses.push('full_name = @fullName');
      request.input('fullName', sql.VarChar(150), fullName);
    }
    if (hasRole) {
      setClauses.push('role = @role');
      request.input('role', sql.VarChar(20), role);
    }

    await request.query(
      `UPDATE auth.users SET ${setClauses.join(', ')} WHERE user_id = @id`
    );

    return res.json(
      ok(
        {
          id,
          email: target.email,
          fullName: hasFullName ? fullName : target.full_name,
          role: hasRole ? role : target.role,
          isActive: !!target.is_active,
        },
        'Usuario actualizado'
      )
    );
  } catch (e) {
    console.error('[users.update]', e);
    return res.status(500).json(err('No fue posible actualizar el usuario'));
  }
}

async function updateUserDepartment(req, res) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json(err('Sin permisos'));
  }

  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json(err('Identificador no válido'));
  }

  const hasDept = Object.prototype.hasOwnProperty.call(
    req.body || {},
    'departmentId'
  );
  if (!hasDept) {
    return res.status(400).json(err('Falta departmentId'));
  }

  const raw = req.body.departmentId;
  let departmentId = null;
  if (raw !== null && raw !== '' && raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return res.status(400).json(err('Departamento inválido'));
    }
    departmentId = parsed;
  }

  try {
    const pool = await getPool();

    const userCheck = await pool
      .request()
      .input('uId', sql.Int, id)
      .query(
        'SELECT user_id FROM auth.users WHERE user_id = @uId AND is_active = 1'
      );
    if (userCheck.recordset.length === 0) {
      return res.status(404).json(err('Usuario no encontrado'));
    }

    if (departmentId !== null) {
      const deptCheck = await pool
        .request()
        .input('dId', sql.Int, departmentId)
        .query(
          'SELECT department_id FROM auth.departments WHERE department_id = @dId AND is_active = 1'
        );
      if (deptCheck.recordset.length === 0) {
        return res.status(400).json(err('Departamento inválido'));
      }
    }

    await pool
      .request()
      .input('uId', sql.Int, id)
      .input('dId', sql.Int, departmentId)
      .query('UPDATE auth.users SET department_id = @dId WHERE user_id = @uId');

    return res.json(ok({ id, departmentId }, 'Departamento actualizado'));
  } catch (e) {
    console.error('[users.updateDepartment]', e);
    return res
      .status(500)
      .json(err('No fue posible actualizar el departamento'));
  }
}

async function uploadAvatar(req, res) {
  const userId = req.user && req.user.userId;
  if (!userId) return res.status(401).json(err('No autenticado'));

  const { dataUrl } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') {
    return res.status(400).json(err('No se recibio imagen valida'));
  }

  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!match) {
    return res.status(400).json(err('Formato de imagen no soportado'));
  }

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');

  if (buffer.length > 500 * 1024) {
    return res.status(400).json(err('La imagen excede el tamaño permitido'));
  }

  if (!fs.existsSync(AVATAR_DIR)) {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
  }

  removeExistingAvatars(userId);

  const filename = `${userId}.${ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, filename), buffer);

  const avatarUrl = `/uploads/avatars/${filename}?v=${Date.now()}`;

  try {
    const pool = await getPool();
    await pool
      .request()
      .input('uId', sql.Int, userId)
      .input('url', sql.VarChar(255), avatarUrl)
      .query('UPDATE auth.users SET avatar_url = @url WHERE user_id = @uId');
    return res.json(ok({ avatarUrl }, 'Foto actualizada'));
  } catch (e) {
    console.error('[users.uploadAvatar]', e);
    return res.status(500).json(err('No fue posible actualizar la foto'));
  }
}

async function dismissAvatarPrompt(req, res) {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('uId', sql.Int, req.user.userId)
      .query(
        `UPDATE auth.users SET avatar_prompt_seen = 1 WHERE user_id = @uId`
      );
    return res.json(ok({}, 'OK'));
  } catch (e) {
    console.error('[users.dismissAvatarPrompt]', e);
    return res
      .status(500)
      .json(err('No fue posible registrar la preferencia'));
  }
}

async function deleteAvatar(req, res) {
  const userId = req.user && req.user.userId;
  if (!userId) return res.status(401).json(err('No autenticado'));

  removeExistingAvatars(userId);

  try {
    const pool = await getPool();
    await pool
      .request()
      .input('uId', sql.Int, userId)
      .query('UPDATE auth.users SET avatar_url = NULL WHERE user_id = @uId');
    return res.json(ok({ avatarUrl: null }, 'Foto eliminada'));
  } catch (e) {
    console.error('[users.deleteAvatar]', e);
    return res.status(500).json(err('No fue posible eliminar la foto'));
  }
}

// [apiKey, dbColumn, defaultValue, type ('bit' | 'int')]
const PREF_FIELDS = [
  ['emailNewNote', 'email_new_note', true, 'bit'],
  ['emailNoteReply', 'email_note_reply', true, 'bit'],
  ['emailSummaryChange', 'email_summary_change', true, 'bit'],
  ['emailParticipationCancelled', 'email_participation_cancelled', true, 'bit'],
  ['emailReminders', 'email_reminders', true, 'bit'],
  ['emailBlockedInvitation', 'email_blocked_invitation', true, 'bit'],
  ['emailAttendanceMarked', 'email_attendance_marked', false, 'bit'],
  ['browserMeetingReminder', 'browser_meeting_reminder', true, 'bit'],
  ['browserMeetingReminderMinutes', 'browser_meeting_reminder_minutes', 10, 'int'],
  ['browserReminderDue', 'browser_reminder_due', true, 'bit'],
];

const VALID_REMINDER_MINUTES = new Set([5, 10, 15, 30, 60]);

function mapPrefRow(row) {
  const out = {};
  for (const [api, col, , type] of PREF_FIELDS) {
    if (type === 'int') {
      out[api] = row[col] != null ? row[col] : null;
    } else {
      out[api] = row[col] === true || row[col] === 1;
    }
  }
  return out;
}

async function getNotificationPreferences(req, res) {
  try {
    const pool = await getPool();
    let result = await pool
      .request()
      .input('uId', sql.Int, req.user.userId)
      .query(`
        SELECT ${PREF_FIELDS.map((f) => f[1]).join(', ')}
        FROM auth.user_notification_preferences
        WHERE user_id = @uId
      `);

    if (result.recordset.length === 0) {
      await pool
        .request()
        .input('uId', sql.Int, req.user.userId)
        .query(`INSERT INTO auth.user_notification_preferences (user_id) VALUES (@uId)`);
      result = await pool
        .request()
        .input('uId', sql.Int, req.user.userId)
        .query(`
          SELECT ${PREF_FIELDS.map((f) => f[1]).join(', ')}
          FROM auth.user_notification_preferences
          WHERE user_id = @uId
        `);
    }

    return res.json(ok(mapPrefRow(result.recordset[0]), 'OK'));
  } catch (e) {
    console.error('[users.getNotificationPreferences]', e);
    return res
      .status(500)
      .json(err('No fue posible cargar las preferencias'));
  }
}

async function updateNotificationPreferences(req, res) {
  try {
    const pool = await getPool();
    const body = req.body || {};

    const exists = await pool
      .request()
      .input('uId', sql.Int, req.user.userId)
      .query(`SELECT 1 AS x FROM auth.user_notification_preferences WHERE user_id = @uId`);
    if (exists.recordset.length === 0) {
      await pool
        .request()
        .input('uId', sql.Int, req.user.userId)
        .query(`INSERT INTO auth.user_notification_preferences (user_id) VALUES (@uId)`);
    }

    const request = pool.request().input('uId', sql.Int, req.user.userId);
    const sets = [];
    for (const [apiKey, col, , type] of PREF_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(body, apiKey)) continue;
      if (type === 'int') {
        const n = parseInt(body[apiKey], 10);
        if (!Number.isInteger(n) || !VALID_REMINDER_MINUTES.has(n)) {
          return res
            .status(400)
            .json(err('Minutos de recordatorio no válidos'));
        }
        request.input(col, sql.Int, n);
      } else {
        const value =
          body[apiKey] === true || body[apiKey] === 'true' ? 1 : 0;
        request.input(col, sql.Bit, value);
      }
      sets.push(`${col} = @${col}`);
    }
    if (sets.length === 0) {
      return res.status(400).json(err('No hay cambios para guardar'));
    }
    sets.push('updated_at = SYSDATETIME()');

    await request.query(`
      UPDATE auth.user_notification_preferences
      SET ${sets.join(', ')}
      WHERE user_id = @uId
    `);

    const refreshed = await pool
      .request()
      .input('uId', sql.Int, req.user.userId)
      .query(`
        SELECT ${PREF_FIELDS.map((f) => f[1]).join(', ')}
        FROM auth.user_notification_preferences
        WHERE user_id = @uId
      `);

    return res.json(ok(mapPrefRow(refreshed.recordset[0]), 'Preferencias guardadas'));
  } catch (e) {
    console.error('[users.updateNotificationPreferences]', e);
    return res
      .status(500)
      .json(err('No fue posible guardar las preferencias'));
  }
}

module.exports = {
  picker,
  listUsers,
  createUser,
  setActive,
  updateUser,
  updateUserDepartment,
  uploadAvatar,
  deleteAvatar,
  dismissAvatarPrompt,
  getNotificationPreferences,
  updateNotificationPreferences,
};
