const { getPool, sql } = require('../config/db');
const { ok, err } = require('../utils/reply');

async function listPeople(req, res) {
  const meId = req.user.userId;
  const search = String(req.query.q || '').trim();

  try {
    const pool = await getPool();

    const usersRes = await pool
      .request()
      .input('me', sql.Int, meId)
      .input('q', sql.NVarChar(150), `%${search}%`)
      .query(`
        SELECT
          u.user_id    AS id,
          u.email,
          u.full_name  AS fullName,
          u.avatar_url AS avatarUrl,
          u.role,
          u.department_id AS departmentId,
          d.name       AS departmentName,
          d.color_hex  AS departmentColor
        FROM auth.users u
        LEFT JOIN auth.departments d ON d.department_id = u.department_id
        WHERE u.is_active = 1
          AND u.user_id != @me
          AND (
            u.full_name COLLATE Latin1_General_CI_AI LIKE @q COLLATE Latin1_General_CI_AI
            OR u.email   COLLATE Latin1_General_CI_AI LIKE @q COLLATE Latin1_General_CI_AI
          )
        ORDER BY u.full_name, u.email
      `);

    const userIds = usersRes.recordset.map((u) => u.id);
    if (userIds.length === 0) {
      return res.json(ok([], 'OK'));
    }

    const idsCsv = userIds.join(',');
    const now = new Date();
    const nextHour = new Date(now.getTime() + 60 * 60 * 1000);

    // Reunion actual (en curso) de cada usuario
    const currentRes = await pool
      .request()
      .input('now', sql.DateTime2, now)
      .query(`
        SELECT DISTINCT
          CASE WHEN r.created_by IN (${idsCsv}) THEN r.created_by ELSE rp.user_id END AS userId,
          r.title,
          r.ends_at AS endsAt,
          r.reservation_type AS reservationType,
          ro.name AS roomName,
          r.external_address AS externalAddress
        FROM core.reservations r
        LEFT JOIN core.reservation_participants rp ON rp.reservation_id = r.reservation_id
        LEFT JOIN core.rooms ro ON ro.room_id = r.room_id
        WHERE r.status = 'active'
          AND r.starts_at <= @now AND r.ends_at > @now
          AND (r.created_by IN (${idsCsv}) OR rp.user_id IN (${idsCsv}))
      `);

    // Proxima reunion (en la siguiente hora)
    const upcomingRes = await pool
      .request()
      .input('now', sql.DateTime2, now)
      .input('next', sql.DateTime2, nextHour)
      .query(`
        SELECT
          CASE WHEN r.created_by IN (${idsCsv}) THEN r.created_by ELSE rp.user_id END AS userId,
          MIN(r.starts_at) AS startsAt
        FROM core.reservations r
        LEFT JOIN core.reservation_participants rp ON rp.reservation_id = r.reservation_id
        WHERE r.status = 'active'
          AND r.starts_at > @now AND r.starts_at <= @next
          AND (r.created_by IN (${idsCsv}) OR rp.user_id IN (${idsCsv}))
        GROUP BY CASE WHEN r.created_by IN (${idsCsv}) THEN r.created_by ELSE rp.user_id END
      `);

    const currentByUser = new Map();
    for (const row of currentRes.recordset) {
      // Tomar la primera coincidencia (un usuario solo puede estar en una a la vez por overlap).
      if (!currentByUser.has(row.userId)) currentByUser.set(row.userId, row);
    }
    const upcomingByUser = new Map(
      upcomingRes.recordset.map((r) => [r.userId, r.startsAt])
    );

    const result = usersRes.recordset.map((u) => {
      const current = currentByUser.get(u.id);
      const upcoming = upcomingByUser.get(u.id);

      let status;
      if (current) {
        const isVirt = current.reservationType === 'virtual';
        const isExt = current.reservationType === 'external';
        status = {
          kind: 'in_meeting',
          endsAt: current.endsAt,
          title: current.title,
          type: current.reservationType,
          roomName: isVirt
            ? 'Reunión virtual'
            : isExt
              ? `Fuera de oficina${current.externalAddress ? ' · ' + current.externalAddress : ''}`
              : current.roomName,
          roomIsVirtual: isVirt,
        };
      } else if (upcoming) {
        const minutesUntil = Math.max(
          0,
          Math.round((new Date(upcoming).getTime() - now.getTime()) / 60000)
        );
        status = { kind: 'soon', minutesUntil, startsAt: upcoming };
      } else {
        status = { kind: 'available' };
      }

      return { ...u, status };
    });

    return res.json(ok(result, 'OK'));
  } catch (e) {
    console.error('[people.listPeople]', e);
    return res.status(500).json(err('No fue posible cargar los colaboradores'));
  }
}

async function getPerson(req, res) {
  const targetId = parseInt(req.params.id, 10);
  if (!targetId) return res.status(400).json(err('Identificador no valido'));

  try {
    const pool = await getPool();

    const userRes = await pool
      .request()
      .input('uId', sql.Int, targetId)
      .query(`
        SELECT
          u.user_id    AS id,
          u.email,
          u.full_name  AS fullName,
          u.avatar_url AS avatarUrl,
          u.role,
          u.is_active  AS isActive,
          u.department_id AS departmentId,
          d.name       AS departmentName,
          d.color_hex  AS departmentColor
        FROM auth.users u
        LEFT JOIN auth.departments d ON d.department_id = u.department_id
        WHERE u.user_id = @uId
      `);

    if (userRes.recordset.length === 0) {
      return res.status(404).json(err('Colaborador no encontrado'));
    }
    const user = userRes.recordset[0];
    if (!user.isActive) {
      return res.status(404).json(err('Colaborador no disponible'));
    }

    const now = new Date();
    const limit = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    const meetingsRes = await pool
      .request()
      .input('uId', sql.Int, targetId)
      .input('now', sql.DateTime2, now)
      .input('limit', sql.DateTime2, limit)
      .query(`
        SELECT TOP 6
          r.reservation_id   AS id,
          r.title,
          r.starts_at        AS startsAt,
          r.ends_at          AS endsAt,
          r.reservation_type AS reservationType,
          r.external_address AS externalAddress,
          ro.name            AS roomName,
          CASE
            WHEN r.starts_at <= @now AND r.ends_at > @now THEN 'in_progress'
            ELSE 'upcoming'
          END                AS state
        FROM core.reservations r
        LEFT JOIN core.rooms ro ON ro.room_id = r.room_id
        LEFT JOIN core.reservation_participants rp ON rp.reservation_id = r.reservation_id
        WHERE r.status = 'active'
          AND r.ends_at >= @now AND r.starts_at <= @limit
          AND (r.created_by = @uId OR rp.user_id = @uId)
        GROUP BY r.reservation_id, r.title, r.starts_at, r.ends_at,
                 r.reservation_type, r.external_address, ro.name
        ORDER BY r.starts_at
      `);

    return res.json(
      ok(
        {
          ...user,
          meetings: meetingsRes.recordset.map((m) => {
            const isVirt = m.reservationType === 'virtual';
            const isExt = m.reservationType === 'external';
            return {
              id: m.id,
              title: m.title,
              startsAt: m.startsAt,
              endsAt: m.endsAt,
              state: m.state,
              type: m.reservationType,
              roomName: isVirt
                ? 'Reunión virtual'
                : isExt
                  ? `Fuera de oficina${m.externalAddress ? ' · ' + m.externalAddress : ''}`
                  : m.roomName,
              roomIsVirtual: isVirt,
            };
          }),
        },
        'OK'
      )
    );
  } catch (e) {
    console.error('[people.getPerson]', e);
    return res
      .status(500)
      .json(err('No fue posible cargar el detalle del colaborador'));
  }
}

module.exports = { listPeople, getPerson };
