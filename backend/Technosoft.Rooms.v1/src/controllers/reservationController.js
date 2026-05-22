const { getPool, sql } = require("../config/db");
const { ok, err } = require("../utils/reply");
const {
  validateReservation,
  roundToNearest5Minutes,
} = require("../utils/validateReservation");
const { findUsersWithOverlap } = require("../utils/checkOverlap");
const { logHistory } = require("../utils/historyLogger");
const {
  createNotification,
  createNotificationsForParticipants,
} = require("../utils/createNotification");
const {
  notifyParticipants,
  sendParticipationCancelledEmail,
  sendGuestInvitationEmail,
  sendGuestCancellationEmail,
  sendGuestRescheduledEmail,
  sendMeetingEndedEarlyEmail,
  sendGuestMeetingEndedEarlyEmail,
  sendBlockedInvitationEmail,
} = require("../services/mailer");
const {
  RESERVATION_TYPES,
  VALID_TYPES,
} = require("../constants/reservationTypes");
const {
  VALID_EXTERNAL_SUBTYPES,
  VIRTUAL_PLATFORMS,
} = require("../constants/externalSubtypes");
const { validateUrl } = require("../utils/urlValidator");
const { findBlocksInRange } = require("../utils/blockDetector");

// Límites de longitud (mantener sincronizados con el frontend).
const LIMITS = {
  TITLE: 60,
  DESCRIPTION: 300,
  EXTERNAL_ADDRESS: 300,
  REASON: 300,
  MEETING_LINK: 500,
  ABSENCE_REASON: 300,
  NOTE: 1000,
  GUEST_DISPLAY_NAME: 120,
  GUEST_EMAIL: 254,
  END_EARLY_REASON: 300,
};

// SELECT columnar de reservas con datos del creador, sala (solo physical),
// quien canceló y quien terminó antes. Si agregas columnas, replicalas aqui
// y en mapReservation.
const RESERVATION_FIELDS = `
  r.reservation_id,
  r.reservation_type,
  r.room_id,
  ro.name        AS room_name,
  ro.color_hex   AS room_color,
  ro.icon_name   AS room_icon,
  ro.description AS room_description,
  ro.capacity    AS room_capacity,
  ro.location    AS room_location,
  r.meeting_link,
  r.external_address,
  r.external_subtype,
  r.external_company,
  r.external_maps_url,
  r.external_contact,
  r.virtual_platform,
  r.created_by,
  u.full_name    AS user_full_name,
  u.email        AS user_email,
  u.avatar_url   AS user_avatar_url,
  u.department_id AS organizer_department_id,
  CASE WHEN r.reservation_type = 'office' THEN dpt.office_name ELSE NULL END AS office_name,
  CASE WHEN r.reservation_type = 'office' THEN dpt.department_id ELSE NULL END AS office_department_id,
  r.title, r.description, r.starts_at, r.ends_at, r.status, r.created_at,
  (
    SELECT COUNT(*) FROM core.reservation_participants rp
    WHERE rp.reservation_id = r.reservation_id AND rp.status = 'active'
  ) AS participants_count,
  (
    SELECT COUNT(*) FROM core.reservation_attachments ra
    WHERE ra.reservation_id = r.reservation_id
  ) AS attachments_count,
  (
    SELECT COUNT(*) FROM core.reservation_notes rn
    WHERE rn.reservation_id = r.reservation_id AND rn.is_deleted = 0
  ) AS notes_count,
  (
    SELECT COUNT(*) FROM core.reservation_participants rpp
    WHERE rpp.reservation_id = r.reservation_id
      AND rpp.invitation_status = 'pending'
  ) AS pending_responses_count,
  r.cancelled_at, r.cancelled_by, r.cancel_reason,
  cb.full_name   AS cancelled_by_name,
  r.ended_early, r.ended_at, r.ended_by, r.end_early_reason,
  eb.full_name   AS ended_by_name,
  r.usage_confirmed, r.usage_confirmed_at, r.usage_confirmation_requested_at,
  r.recurring_series_id,
  r.is_exception,
  rs.title             AS series_title,
  rs.pattern           AS series_pattern,
  rs.days_of_week      AS series_days_of_week,
  rs.frequency_weeks   AS series_frequency_weeks,
  rs.day_of_month      AS series_day_of_month
`;
const RESERVATION_FROM = `
  FROM core.reservations r
  LEFT JOIN core.rooms ro              ON ro.room_id = r.room_id
  LEFT JOIN auth.users u               ON u.user_id  = r.created_by
  LEFT JOIN auth.departments dpt       ON dpt.department_id = u.department_id
  LEFT JOIN auth.users cb              ON cb.user_id = r.cancelled_by
  LEFT JOIN auth.users eb              ON eb.user_id = r.ended_by
  LEFT JOIN core.recurring_series rs   ON rs.series_id = r.recurring_series_id
`;

const mapReservation = (r) => ({
  id: r.reservation_id,
  type: r.reservation_type,
  roomId: r.room_id != null ? r.room_id : null,
  roomName: r.room_name || null,
  roomColor: r.room_color || null,
  roomIcon: r.room_icon || null,
  roomDescription: r.room_description || null,
  roomCapacity: r.room_capacity != null ? r.room_capacity : null,
  roomLocation: r.room_location || null,
  meetingLink: r.meeting_link || null,
  externalAddress: r.external_address || null,
  externalSubtype: r.external_subtype || null,
  externalCompany: r.external_company || null,
  externalMapsUrl: r.external_maps_url || null,
  externalContact: r.external_contact || null,
  virtualPlatform: r.virtual_platform || null,
  createdBy: r.created_by,
  userFullName: r.user_full_name,
  userEmail: r.user_email,
  userAvatarUrl: r.user_avatar_url,
  organizerDepartmentId:
    r.organizer_department_id != null ? r.organizer_department_id : null,
  officeName: r.office_name || null,
  officeDepartmentId:
    r.office_department_id != null ? r.office_department_id : null,
  title: r.title,
  description: r.description,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  status: r.status,
  createdAt: r.created_at,
  participantsCount: r.participants_count != null ? r.participants_count : 0,
  attachmentsCount: r.attachments_count != null ? r.attachments_count : 0,
  notesCount: r.notes_count != null ? r.notes_count : 0,
  pendingResponsesCount:
    r.pending_responses_count != null ? r.pending_responses_count : 0,
  cancelledAt: r.cancelled_at || null,
  cancelledBy: r.cancelled_by != null ? r.cancelled_by : null,
  cancelledByName: r.cancelled_by_name || null,
  cancelReason: r.cancel_reason || null,
  endedEarly: !!r.ended_early,
  endedAt: r.ended_at || null,
  endedById: r.ended_by != null ? r.ended_by : null,
  endedByName: r.ended_by_name || null,
  endEarlyReason: r.end_early_reason || null,
  usageConfirmed: !!r.usage_confirmed,
  usageConfirmedAt: r.usage_confirmed_at || null,
  usageConfirmationRequestedAt: r.usage_confirmation_requested_at || null,
  recurringSeriesId: r.recurring_series_id != null ? r.recurring_series_id : null,
  isException: r.is_exception === true || r.is_exception === 1,
  series: r.recurring_series_id
    ? {
        id: r.recurring_series_id,
        title: r.series_title || null,
        pattern: r.series_pattern || null,
        daysOfWeek: r.series_days_of_week || null,
        frequencyWeeks:
          r.series_frequency_weeks != null ? r.series_frequency_weeks : null,
        dayOfMonth:
          r.series_day_of_month != null ? r.series_day_of_month : null,
      }
    : null,
});

function validateMeetingLink(value) {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, msg: "El enlace de reunión es inválido" };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > 500) {
    return { ok: false, msg: "El enlace de reunión es demasiado largo" };
  }
  const check = validateUrl(trimmed, "enlace de reunión");
  if (!check.valid) return { ok: false, msg: check.error };
  return { ok: true, value: trimmed };
}

const PAD = (n) => String(n).padStart(2, "0");

function fmtDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  const dias = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const meses = [
    "ene",
    "feb",
    "mar",
    "abr",
    "may",
    "jun",
    "jul",
    "ago",
    "sep",
    "oct",
    "nov",
    "dic",
  ];
  return `${dias[d.getDay()]} ${d.getDate()} ${meses[d.getMonth()]} · ${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

function fmtHora(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

function notificationBody(title, startsAt) {
  return `${title} · ${fmtDateTime(startsAt)}`;
}

async function buildOverlapMessage(pool, overlappingIds, selfUserId) {
  if (overlappingIds.length === 0) return "";
  const placeholders = overlappingIds.map((_, i) => `@o${i}`).join(",");
  const req = pool.request();
  overlappingIds.forEach((id, i) => req.input(`o${i}`, sql.Int, id));
  const result = await req.query(
    `SELECT user_id, full_name, email
     FROM auth.users WHERE user_id IN (${placeholders})`
  );
  const byId = new Map(
    result.recordset.map((u) => [u.user_id, u.full_name || u.email])
  );
  const isSelf = overlappingIds.includes(selfUserId);
  const others = overlappingIds
    .filter((id) => id !== selfUserId)
    .map((id) => byId.get(id))
    .filter(Boolean);

  if (isSelf && others.length === 0) {
    return "Ya tienes una reserva en ese horario.";
  }
  if (isSelf) {
    return `Ya tienes una reserva en ese horario. Otros con conflicto: ${others.join(", ")}.`;
  }
  return `Los siguientes colaboradores ya tienen una reserva en ese horario: ${others.join(", ")}.`;
}

// Envía correo + notificación interna a los participantes que tienen un
// bloqueo personal solapando con la reunión. Espera blockedParticipants =
// [{ user: {user_id,email,full_name}, blockId }, ...]. Resuelve el nombre
// del bloqueo desde DB para incluirlo en el mensaje.
async function notifyBlockedParticipants({
  reservationId,
  blockedParticipants,
  title,
  startsAt,
  endsAt,
  organizerName,
}) {
  if (!blockedParticipants || blockedParticipants.length === 0) return;
  const pool = await getPool();

  // Cache de nombres de bloqueo
  const blockIds = [...new Set(blockedParticipants.map((b) => b.blockId))];
  let nameByBlockId = new Map();
  if (blockIds.length > 0) {
    const placeholders = blockIds.map((_, i) => `@b${i}`).join(",");
    const req = pool.request();
    blockIds.forEach((id, i) => req.input(`b${i}`, sql.Int, id));
    const result = await req.query(
      `SELECT block_id, name FROM auth.user_blocks WHERE block_id IN (${placeholders})`
    );
    for (const r of result.recordset) {
      nameByBlockId.set(r.block_id, r.name);
    }
  }

  for (const bp of blockedParticipants) {
    const blockName = nameByBlockId.get(bp.blockId) || "tu bloqueo personal";
    try {
      await sendBlockedInvitationEmail({
        to: bp.user.email,
        recipientName: bp.user.full_name || bp.user.email,
        organizerName,
        meetingTitle: title,
        startsAt,
        endsAt,
        blockName,
      });
    } catch (e) {
      console.error("[notifyBlockedParticipants] mail", bp.user.email, e.message);
    }

    try {
      await createNotification({
        userId: bp.user.user_id,
        reservationId,
        type: "invitation_blocked",
        title: `Invitación con bloqueo: ${title}`,
        body: `${organizerName} te invitó a una reunión que coincide con tu bloqueo "${blockName}"`,
      });
    } catch (e) {
      console.error("[notifyBlockedParticipants] notif", e.message);
    }
  }
}

// Devuelve array de IDs unicos, validos (enteros positivos) y distintos al creador.
const sanitizeIds = (ids, excludeUserId) =>
  [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0 && id !== excludeUserId
  );

// Resuelve departmentIds a IDs de usuarios activos (snapshot). Valida que
// los departamentos existan y estén activos. Lanza Error si alguno no es válido.
async function resolveDepartmentMembers(pool, departmentIds, excludeUserId) {
  const cleanDeptIds = [
    ...new Set((Array.isArray(departmentIds) ? departmentIds : []).map(Number)),
  ].filter((id) => Number.isInteger(id) && id > 0);

  if (cleanDeptIds.length === 0) return { departmentIds: [], memberIds: [] };

  const deptPlaceholders = cleanDeptIds.map((_, i) => `@d${i}`).join(",");
  const reqDept = pool.request();
  cleanDeptIds.forEach((id, i) => reqDept.input(`d${i}`, sql.Int, id));
  const deptCheck = await reqDept.query(
    `SELECT department_id FROM auth.departments
     WHERE department_id IN (${deptPlaceholders}) AND is_active = 1`
  );
  if (deptCheck.recordset.length !== cleanDeptIds.length) {
    const err = new Error("Algún departamento es inválido");
    err.code = "INVALID_DEPARTMENT";
    throw err;
  }

  const memberReq = pool.request().input("me", sql.Int, excludeUserId);
  cleanDeptIds.forEach((id, i) => memberReq.input(`d${i}`, sql.Int, id));
  const membersRes = await memberReq.query(`
    SELECT DISTINCT user_id
    FROM auth.users
    WHERE department_id IN (${deptPlaceholders})
      AND is_active = 1
      AND user_id <> @me
  `);
  return {
    departmentIds: cleanDeptIds,
    memberIds: membersRes.recordset.map((r) => r.user_id),
  };
}

// Resuelve los IDs a registros activos de auth.users. Los inactivos o inexistentes
// quedan fuera silenciosamente.
async function loadActiveUsers(pool, ids) {
  if (!ids || ids.length === 0) return [];
  const placeholders = ids.map((_, i) => `@p${i}`).join(",");
  const req = pool.request();
  ids.forEach((id, i) => req.input(`p${i}`, sql.Int, id));
  const result = await req.query(
    `SELECT user_id, email, full_name
     FROM auth.users
     WHERE user_id IN (${placeholders}) AND is_active = 1`
  );
  return result.recordset;
}

async function insertParticipants(pool, reservationId, users, userBlockMap) {
  // userBlockMap: Map<userId, blockId>. Si un participante tiene bloqueo,
  // su invitación queda 'pending' con referencia al bloqueo. El resto entra
  // como 'auto_accepted'.
  const blockMap = userBlockMap || new Map();
  for (const u of users) {
    const blockedById = blockMap.get(u.user_id) || null;
    const invStatus = blockedById ? "pending" : "auto_accepted";
    await pool
      .request()
      .input("rId", sql.Int, reservationId)
      .input("uId", sql.Int, u.user_id)
      .input("invStatus", sql.VarChar(20), invStatus)
      .input("blockedById", sql.Int, blockedById)
      .query(
        `INSERT INTO core.reservation_participants
           (reservation_id, user_id, invitation_status, invitation_blocked_by_id)
         VALUES (@rId, @uId, @invStatus, @blockedById)`
      );
  }
}

async function fetchRoom(pool, roomId) {
  const r = await pool
    .request()
    .input("roomId", sql.Int, roomId)
    .query(`SELECT name, location, capacity FROM core.rooms WHERE room_id = @roomId`);
  return r.recordset[0] || null;
}

// Adjunta hasta N participantes activos por reserva. Muta cada elemento de
// `reservations` añadiendo el campo `participants` (array de UserPickerItem).
async function attachParticipants(pool, reservations) {
  if (!Array.isArray(reservations) || reservations.length === 0) return;
  const ids = reservations.map((r) => r.id);
  const placeholders = ids.map((_, i) => `@r${i}`).join(",");
  const req = pool.request();
  ids.forEach((id, i) => req.input(`r${i}`, sql.Int, id));
  const result = await req.query(`
    SELECT
      rp.reservation_id      AS reservationId,
      rp.user_id             AS userId,
      u.full_name            AS fullName,
      u.email                AS email,
      u.avatar_url           AS avatarUrl,
      rp.status              AS status,
      rp.invitation_status   AS invitationStatus,
      rp.created_at          AS createdAt
    FROM core.reservation_participants rp
    JOIN auth.users u ON u.user_id = rp.user_id
    WHERE rp.reservation_id IN (${placeholders})
      AND rp.status = 'active'
    ORDER BY rp.reservation_id, rp.created_at
  `);
  const byReservation = new Map();
  for (const p of result.recordset) {
    if (!byReservation.has(p.reservationId)) byReservation.set(p.reservationId, []);
    byReservation.get(p.reservationId).push({
      id: p.userId,
      email: p.email,
      fullName: p.fullName,
      avatarUrl: p.avatarUrl,
      status: p.status,
      invitationStatus: p.invitationStatus,
    });
  }
  for (const r of reservations) {
    r.participants = byReservation.get(r.id) || [];
  }
}

const getByDateRange = async (req, res) => {
  const { from, to, roomId } = req.query || {};
  if (!from || !to) {
    return res.status(400).json(err("Rango de fechas requerido"));
  }
  try {
    const pool = await getPool();
    const request = pool
      .request()
      .input("from", sql.DateTime2, new Date(from))
      .input("to", sql.DateTime2, new Date(to));

    // Dashboard diaria: reuniones physical + office (mismo carril visual).
    // Virtuales/externas se sirven por endpoints separados.
    let where = `WHERE r.status = 'active' AND r.starts_at < @to AND r.ends_at > @from AND r.reservation_type IN ('physical', 'office')`;
    if (roomId) {
      where += " AND r.room_id = @roomId";
      request.input("roomId", sql.Int, parseInt(roomId, 10));
    }

    const result = await request.query(`
      SELECT ${RESERVATION_FIELDS}
      ${RESERVATION_FROM}
      ${where}
      ORDER BY r.starts_at ASC
    `);
    const items = result.recordset.map(mapReservation);
    await attachParticipants(pool, items);
    return res.json(ok(items));
  } catch (e) {
    console.error("[reservation.getByDateRange]", e);
    return res.status(500).json(err("No fue posible obtener las reservas"));
  }
};

const VALID_MINE_TYPES = new Set(["physical", "virtual", "external", "office"]);
const VALID_MINE_STATUS = new Set([
  "active",
  "past",
  "cancelled",
  "in_progress",
]);
const VALID_MINE_ROLE = new Set(["organizer", "participant"]);

const getMine = async (req, res) => {
  try {
    const pool = await getPool();
    const request = pool.request().input("userId", sql.Int, req.user.userId);

    // Membership: el usuario es organizador, o tiene un registro de
    // participante NO rechazado en la reserva.
    const baseMembership = `(
      r.created_by = @userId
      OR EXISTS (
        SELECT 1 FROM core.reservation_participants rp
        WHERE rp.reservation_id = r.reservation_id
          AND rp.user_id = @userId
          AND (rp.status IS NULL OR rp.status = 'active')
      )
    )`;
    const where = [baseMembership];

    const type = String(req.query.type || "").trim();
    if (type && VALID_MINE_TYPES.has(type)) {
      request.input("type", sql.VarChar(20), type);
      where.push("r.reservation_type = @type");
    }

    const status = String(req.query.status || "").trim();
    if (status === "cancelled") {
      where.push("r.status = 'cancelled'");
    } else if (status === "in_progress") {
      where.push(
        "r.status = 'active' AND r.starts_at <= SYSDATETIME() AND r.ends_at >= SYSDATETIME()"
      );
    } else if (status === "active") {
      where.push("r.status = 'active' AND r.starts_at > SYSDATETIME()");
    } else if (status === "past") {
      where.push("r.status = 'active' AND r.ends_at < SYSDATETIME()");
    } else if (status && !VALID_MINE_STATUS.has(status)) {
      // estado desconocido → ignorar silenciosamente
    }

    const role = String(req.query.role || "").trim();
    if (role === "organizer") {
      where.push("r.created_by = @userId");
    } else if (role === "participant") {
      where.push(
        `r.created_by <> @userId
         AND EXISTS (
           SELECT 1 FROM core.reservation_participants rp2
           WHERE rp2.reservation_id = r.reservation_id
             AND rp2.user_id = @userId
         )`
      );
    } else if (role && !VALID_MINE_ROLE.has(role)) {
      // rol desconocido → ignorar
    }

    const recurring = String(req.query.recurring || "").trim();
    if (recurring === "true") {
      where.push("r.recurring_series_id IS NOT NULL");
    } else if (recurring === "false") {
      where.push("r.recurring_series_id IS NULL");
    }

    const dateFromRaw = String(req.query.dateFrom || "").trim();
    if (dateFromRaw) {
      const d = new Date(dateFromRaw);
      if (!isNaN(d.getTime())) {
        d.setHours(0, 0, 0, 0);
        request.input("dateFrom", sql.DateTime2, d);
        where.push("r.starts_at >= @dateFrom");
      }
    }

    const dateToRaw = String(req.query.dateTo || "").trim();
    if (dateToRaw) {
      const d = new Date(dateToRaw);
      if (!isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        request.input("dateTo", sql.DateTime2, d);
        where.push("r.starts_at <= @dateTo");
      }
    }

    // Deduplicar series recurrentes:
    //   - Reuniones SIN serie: pasan todas.
    //   - Reuniones CON serie: por cada serie devolvemos a lo sumo 2 filas:
    //       la proxima futura (la mas cercana al ahora, starts_at >= NOW)
    //       la ultima pasada (la mas reciente, starts_at < NOW)
    //
    // Usamos dos ROW_NUMBER explicitas (una ASC para futuras, otra DESC para
    // pasadas) particionando por (series_id, is_future). La CASE final elige
    // cual aplica segun el bucket de la fila. Asi cada serie aporta como
    // maximo dos filas (rn=1 en cada bucket) y la logica no depende de
    // tie-breaking de NULLs en ORDER BY.
    const result = await request.query(`
      WITH filtered AS (
        SELECT ${RESERVATION_FIELDS},
          CASE WHEN r.starts_at >= SYSDATETIME() THEN 1 ELSE 0 END AS is_future
        ${RESERVATION_FROM}
        WHERE ${where.join(" AND ")}
      ),
      bucketed AS (
        SELECT
          *,
          CASE
            WHEN recurring_series_id IS NULL THEN 1
            WHEN is_future = 1 THEN ROW_NUMBER() OVER (
              PARTITION BY recurring_series_id, is_future
              ORDER BY starts_at ASC
            )
            ELSE ROW_NUMBER() OVER (
              PARTITION BY recurring_series_id, is_future
              ORDER BY starts_at DESC
            )
          END AS rn
        FROM filtered
      )
      SELECT *
      FROM bucketed
      WHERE rn = 1
      ORDER BY starts_at DESC
    `);
    const mapped = result.recordset.map(mapReservation);
    // Diagnostico temporal — eliminar si el endpoint estabiliza:
    if (process.env.LOG_GET_MINE === "1") {
      const now = Date.now();
      const upcomingCount = mapped.filter(
        (r) => r.status === "active" && new Date(r.endsAt).getTime() > now
      ).length;
      const recurringCount = mapped.filter(
        (r) => r.recurringSeriesId != null
      ).length;
      console.log(
        `[reservation.getMine] userId=${req.user.userId} total=${mapped.length} upcoming=${upcomingCount} recurring=${recurringCount}`
      );
      if (mapped.length > 0) {
        console.log(
          "[reservation.getMine] sample=",
          JSON.stringify({
            id: mapped[0].id,
            title: mapped[0].title,
            startsAt: mapped[0].startsAt,
            endsAt: mapped[0].endsAt,
            status: mapped[0].status,
            recurringSeriesId: mapped[0].recurringSeriesId,
          })
        );
      }
    }
    return res.json(ok(mapped));
  } catch (e) {
    console.error("[reservation.getMine]", e);
    return res.status(500).json(err("No fue posible obtener sus reservas"));
  }
};

const getById = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const full = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        SELECT ${RESERVATION_FIELDS}
        ${RESERVATION_FROM}
        WHERE r.reservation_id = @id
      `);
    if (full.recordset.length === 0) {
      return res.status(404).json(err("Reserva no encontrada"));
    }

    const reservation = mapReservation(full.recordset[0]);

    // Determinar si el usuario logueado tiene "acceso interno" (creador o
    // participante). El admin tambien siempre ve todo.
    const me = req.user.userId;
    const isAdmin = req.user.role === "admin";
    let hasFullAccess = isAdmin || reservation.createdBy === me;
    if (!hasFullAccess) {
      const check = await pool
        .request()
        .input("rId", sql.Int, id)
        .input("uId", sql.Int, me)
        .query(
          `SELECT 1 FROM core.reservation_participants
           WHERE reservation_id = @rId AND user_id = @uId`
        );
      hasFullAccess = check.recordset.length > 0;
    }

    if (hasFullAccess) {
      const parts = await pool
        .request()
        .input("rId", sql.Int, id)
        .query(`
          SELECT
            rp.user_id              AS id,
            u.email,
            u.full_name             AS fullName,
            u.avatar_url            AS avatarUrl,
            rp.status,
            rp.cancelled_at         AS cancelledAt,
            rp.cancel_reason        AS cancelReason,
            rp.invitation_status    AS invitationStatus,
            rp.invitation_response_at AS invitationResponseAt,
            rp.invitation_blocked_by_id AS invitationBlockedById,
            b.name                  AS invitationBlockedByName
          FROM core.reservation_participants rp
          JOIN auth.users u ON u.user_id = rp.user_id
          LEFT JOIN auth.user_blocks b ON b.block_id = rp.invitation_blocked_by_id
          WHERE rp.reservation_id = @rId
          ORDER BY
            CASE WHEN rp.status = 'active' THEN 0 ELSE 1 END,
            u.full_name,
            u.email
        `);
      // Privacidad: el nombre del bloqueo solo lo ve el organizador.
      const isOrganizer = reservation.createdBy === me;
      reservation.participants = parts.recordset.map((p) => ({
        ...p,
        invitationBlockedByName: isOrganizer
          ? p.invitationBlockedByName
          : null,
        invitationBlockedById: isOrganizer
          ? p.invitationBlockedById
          : null,
      }));
      return res.json(ok(reservation));
    }

    // Acceso "publico" — datos básicos. Para virtuales y físicas se devuelve
    // título, organizador, sala y horario; se ocultan descripción, link y
    // colaboradores.
    return res.json(
      ok({
        ...reservation,
        description: null,
        meetingLink: null,
        participants: [],
        participantsCount: 0,
        publicView: true,
      })
    );
  } catch (e) {
    console.error("[reservation.getById]", e);
    return res.status(500).json(err("No fue posible obtener la reserva"));
  }
};

const getParticipants = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const parts = await pool
      .request()
      .input("rId", sql.Int, id)
      .query(`
        SELECT
          rp.user_id        AS id,
          u.email,
          u.full_name       AS fullName,
          u.avatar_url      AS avatarUrl,
          rp.status,
          rp.cancelled_at   AS cancelledAt,
          rp.cancel_reason  AS cancelReason
        FROM core.reservation_participants rp
        JOIN auth.users u ON u.user_id = rp.user_id
        WHERE rp.reservation_id = @rId
        ORDER BY
          CASE WHEN rp.status = 'active' THEN 0 ELSE 1 END,
          u.full_name,
          u.email
      `);
    return res.json(ok(parts.recordset));
  } catch (e) {
    console.error("[reservation.getParticipants]", e);
    return res.status(500).json(err("No fue posible obtener los colaboradores"));
  }
};

const create = async (req, res) => {
  const {
    type,
    roomId,
    startsAt,
    endsAt,
    title,
    description,
    meetingLink,
    participantIds,
    departmentIds,
    externalAddress,
    externalSubtype,
    externalCompany,
    externalMapsUrl,
    externalContact,
    virtualPlatform,
  } = req.body || {};
  if (!startsAt || !endsAt || !title) {
    return res.status(400).json(err("Datos incompletos"));
  }
  if (!VALID_TYPES.includes(type)) {
    return res.status(400).json(err("Tipo de reunión no válido"));
  }

  const isPhysical = type === RESERVATION_TYPES.PHYSICAL;
  const isVirtualType = type === RESERVATION_TYPES.VIRTUAL;
  const isExternalType = type === RESERVATION_TYPES.EXTERNAL;
  const isOfficeType = type === RESERVATION_TYPES.OFFICE;

  if (isPhysical && !roomId) {
    return res.status(400).json(err("Debes elegir una sala"));
  }
  if (isOfficeType && roomId != null) {
    return res
      .status(400)
      .json(err("Las reuniones de oficina no llevan sala asignada"));
  }

  // Aceptamos cualquier minuto en el input — redondeamos al múltiplo de 5
  // más cercano para mantener la granularidad de los slots y de los pickers.
  const startsDate = roundToNearest5Minutes(startsAt);
  const endsDate = roundToNearest5Minutes(endsAt);
  const cleanTitle = String(title).trim();
  if (cleanTitle.length === 0) {
    return res.status(400).json(err("El título es obligatorio"));
  }
  if (cleanTitle.length > LIMITS.TITLE) {
    return res
      .status(400)
      .json(err(`El título no puede superar ${LIMITS.TITLE} caracteres`));
  }
  const cleanDesc = description ? String(description).trim() : null;
  if (cleanDesc && cleanDesc.length > LIMITS.DESCRIPTION) {
    return res
      .status(400)
      .json(
        err(`La descripción no puede superar ${LIMITS.DESCRIPTION} caracteres`)
      );
  }

  const cleanExternalAddress =
    isExternalType && externalAddress
      ? String(externalAddress).trim().slice(0, LIMITS.EXTERNAL_ADDRESS)
      : null;
  if (isExternalType && (!cleanExternalAddress || cleanExternalAddress.length < 3)) {
    return res
      .status(400)
      .json(err("Debes indicar la dirección (mínimo 3 caracteres)"));
  }

  let cleanExternalSubtype = null;
  let cleanExternalCompany = null;
  let cleanExternalMapsUrl = null;
  let cleanExternalContact = null;
  if (isExternalType) {
    if (!externalSubtype || !VALID_EXTERNAL_SUBTYPES.includes(externalSubtype)) {
      return res
        .status(400)
        .json(err("Debes elegir el tipo de actividad"));
    }
    cleanExternalSubtype = externalSubtype;
    if (externalCompany != null) {
      const c = String(externalCompany).trim();
      if (c.length > 120) {
        return res
          .status(400)
          .json(err("El nombre del lugar es demasiado largo"));
      }
      cleanExternalCompany = c || null;
    }
    if (externalMapsUrl != null) {
      const u = String(externalMapsUrl).trim();
      if (u.length > 500) {
        return res
          .status(400)
          .json(err("El enlace de Maps es demasiado largo"));
      }
      if (u.length > 0) {
        const urlCheck = validateUrl(u, "enlace de Maps");
        if (!urlCheck.valid) {
          return res.status(400).json(err(urlCheck.error));
        }
      }
      cleanExternalMapsUrl = u || null;
    }
    if (externalContact != null) {
      const c = String(externalContact).trim();
      if (c.length > 120) {
        return res
          .status(400)
          .json(err("El nombre del contacto es demasiado largo"));
      }
      cleanExternalContact = c || null;
    }
  }

  let cleanVirtualPlatform = null;
  if (isVirtualType && virtualPlatform != null) {
    const p = String(virtualPlatform).trim();
    if (p && !VIRTUAL_PLATFORMS.includes(p)) {
      return res.status(400).json(err("Plataforma inválida"));
    }
    cleanVirtualPlatform = p || null;
  }

  let pool;
  try {
    pool = await getPool();
  } catch (e) {
    console.error("[reservation.create] No pool", e);
    return res.status(500).json(err("No fue posible agendar la reunión"));
  }

  // Sala física: validar que exista y esté activa.
  let parsedRoomId = null;
  if (isPhysical) {
    parsedRoomId = parseInt(roomId, 10);
    if (!Number.isInteger(parsedRoomId) || parsedRoomId <= 0) {
      return res.status(400).json(err("Sala no válida"));
    }
    const roomCheck = await pool
      .request()
      .input("id", sql.Int, parsedRoomId)
      .query("SELECT is_active FROM core.rooms WHERE room_id = @id");
    if (
      roomCheck.recordset.length === 0 ||
      !roomCheck.recordset[0].is_active
    ) {
      return res.status(400).json(err("Sala no disponible"));
    }
  }

  // Office: requiere que el creador tenga departamento asignado.
  let organizerDeptIdForOffice = null;
  if (isOfficeType) {
    const userCheck = await pool
      .request()
      .input("uid", sql.Int, req.user.userId)
      .query("SELECT department_id FROM auth.users WHERE user_id = @uid");
    organizerDeptIdForOffice = userCheck.recordset[0]?.department_id ?? null;
    if (organizerDeptIdForOffice == null) {
      return res
        .status(400)
        .json(
          err(
            "Necesitas tener un departamento asignado para crear reuniones de oficina"
          )
        );
    }
  }

  // Enlace de reunión: solo aplica para virtual.
  const linkCheck = validateMeetingLink(meetingLink);
  if (!linkCheck.ok) {
    return res.status(400).json(err(linkCheck.msg));
  }
  const cleanLink = isVirtualType ? linkCheck.value : null;

  // Validación de horario/duración/rango (sin chequear overlap todavía).
  // Para virtual/external se pasa roomId=null y se saltea el overlap de sala.
  const validation = await validateReservation({
    roomId: parsedRoomId,
    startsAt: startsDate,
    endsAt: endsDate,
    pool,
    skipRoomOverlap: true,
    skipRoom: !isPhysical,
  });
  if (!validation.valid) {
    return res.status(400).json(err(validation.msg));
  }

  const cleanIds = sanitizeIds(participantIds, req.user.userId);

  // Snapshot de miembros de los departamentos invitados — al momento del
  // create. Si después se agrega gente a esos departamentos, NO se invita
  // retroactivamente.
  let deptMemberIds = [];
  try {
    const resolved = await resolveDepartmentMembers(
      pool,
      departmentIds,
      req.user.userId
    );
    deptMemberIds = resolved.memberIds;
  } catch (e) {
    if (e.code === "INVALID_DEPARTMENT") {
      return res.status(400).json(err(e.message));
    }
    console.error("[reservation.create] resolveDepartmentMembers", e);
    return res.status(500).json(err("No fue posible procesar los departamentos"));
  }

  // Combinar participantes individuales + miembros de departamentos. Se
  // deduplica para evitar agregar al mismo usuario dos veces si está como
  // colaborador individual Y en un departamento invitado.
  const combinedParticipantIds = [
    ...new Set([...cleanIds, ...deptMemberIds]),
  ].filter((id) => id !== req.user.userId);

  // ---- Transaccion atomica ----
  const transaction = pool.transaction();
  await transaction.begin();
  let newId;
  let validParticipants = [];
  let blockedParticipants = [];
  try {
    // 1. Solapamiento de sala fisica con UPDLOCK+HOLDLOCK. Solo aplica a physical.
    if (isPhysical) {
      const overlapRoom = await transaction
        .request()
        .input("roomId", sql.Int, parsedRoomId)
        .input("startsAt", sql.DateTime2, startsDate)
        .input("endsAt", sql.DateTime2, endsDate)
        .query(`
          SELECT TOP 1 reservation_id
          FROM core.reservations WITH (UPDLOCK, HOLDLOCK)
          WHERE room_id = @roomId
            AND status = 'active'
            AND starts_at < @endsAt
            AND (
              (ended_early = 1 AND ended_at > @startsAt)
              OR (ended_early = 0 AND ends_at > @startsAt)
            )
        `);
      if (overlapRoom.recordset.length > 0) {
        await transaction.rollback();
        return res
          .status(409)
          .json(
            err(
              "Alguien acaba de agendar este horario. Por favor elija otro horario o sala."
            )
          );
      }
    }

    // 1b. Solapamiento de OFICINA del departamento. Dos reuniones de oficina
    //     del mismo departamento no pueden coexistir en el mismo rango.
    if (isOfficeType) {
      const overlapOffice = await transaction
        .request()
        .input("deptId", sql.Int, organizerDeptIdForOffice)
        .input("startsAt", sql.DateTime2, startsDate)
        .input("endsAt", sql.DateTime2, endsDate)
        .query(`
          SELECT TOP 1 r.title
          FROM core.reservations r WITH (UPDLOCK, HOLDLOCK)
          INNER JOIN auth.users uu ON uu.user_id = r.created_by
          WHERE r.reservation_type = 'office'
            AND r.status = 'active'
            AND uu.department_id = @deptId
            AND r.starts_at < @endsAt
            AND (
              (r.ended_early = 1 AND r.ended_at > @startsAt)
              OR (r.ended_early = 0 AND r.ends_at > @startsAt)
            )
        `);
      if (overlapOffice.recordset.length > 0) {
        await transaction.rollback();
        return res
          .status(409)
          .json(
            err(
              `La oficina del departamento ya esta ocupada en ese horario por "${overlapOffice.recordset[0].title}"`
            )
          );
      }
    }

    // 2. Solapamiento de agenda (creador + participantes + miembros de
    //    departamentos invitados) con locks. Aplica a TODOS los tipos: nadie
    //    puede estar en dos reuniones a la vez.
    const allUserIds = [req.user.userId, ...combinedParticipantIds];
    const overlapping = await findUsersWithOverlap({
      userIds: allUserIds,
      startsAt: startsDate,
      endsAt: endsDate,
      transaction,
    });
    if (overlapping.length > 0) {
      const msg = await buildOverlapMessage(pool, overlapping, req.user.userId);
      await transaction.rollback();
      return res.status(409).json(err(msg));
    }

    // 3. INSERT reserva
    const inserted = await transaction
      .request()
      .input("type", sql.VarChar(20), type)
      .input("room_id", sql.Int, isPhysical ? parsedRoomId : null)
      .input("created_by", sql.Int, req.user.userId)
      .input("title", sql.VarChar(150), cleanTitle)
      .input("description", sql.VarChar(500), cleanDesc)
      .input("meeting_link", sql.VarChar(500), cleanLink)
      .input("starts_at", sql.DateTime2, startsDate)
      .input("ends_at", sql.DateTime2, endsDate)
      .input(
        "external_address",
        sql.VarChar(300),
        isExternalType ? cleanExternalAddress : null
      )
      .input(
        "external_subtype",
        sql.VarChar(30),
        isExternalType ? cleanExternalSubtype : null
      )
      .input(
        "external_company",
        sql.VarChar(120),
        isExternalType ? cleanExternalCompany : null
      )
      .input(
        "external_maps_url",
        sql.VarChar(500),
        isExternalType ? cleanExternalMapsUrl : null
      )
      .input(
        "external_contact",
        sql.VarChar(120),
        isExternalType ? cleanExternalContact : null
      )
      .input(
        "virtual_platform",
        sql.VarChar(20),
        isVirtualType ? cleanVirtualPlatform : null
      )
      .query(`
        INSERT INTO core.reservations
          (reservation_type, room_id, created_by, title, description, meeting_link,
           starts_at, ends_at, status, external_address,
           external_subtype, external_company, external_maps_url, external_contact,
           virtual_platform)
        OUTPUT inserted.reservation_id
        VALUES (@type, @room_id, @created_by, @title, @description, @meeting_link,
                @starts_at, @ends_at, 'active', @external_address,
                @external_subtype, @external_company, @external_maps_url, @external_contact,
                @virtual_platform)
      `);
    newId = inserted.recordset[0].reservation_id;

    // 4. INSERT participantes — incluye colaboradores individuales y miembros
    //    de departamentos invitados (snapshot al momento del create).
    if (combinedParticipantIds.length > 0) {
      validParticipants = await loadActiveUsers(
        transaction,
        combinedParticipantIds
      );
      const ignored = combinedParticipantIds.length - validParticipants.length;
      if (ignored > 0) {
        console.log(
          `[reservation.create] ${ignored} ID(s) de colaborador ignorados (inactivos o inexistentes)`
        );
      }
      // Detectar bloqueos personales que se solapan con la reunión. A los
      // participantes con bloqueo se les manda invitación 'pending'; el resto
      // entra 'auto_accepted'.
      const validIds = validParticipants.map((u) => u.user_id);
      let createBlockMap = new Map();
      try {
        const blocks = await findBlocksInRange({
          userIds: validIds,
          startsAt: startsDate,
          endsAt: endsDate,
          pool: transaction,
        });
        for (const b of blocks) {
          if (!createBlockMap.has(b.userId)) {
            createBlockMap.set(b.userId, b.blockId);
          }
        }
      } catch (e) {
        console.error("[reservation.create] findBlocksInRange", e);
      }
      blockedParticipants = validParticipants
        .filter((u) => createBlockMap.has(u.user_id))
        .map((u) => ({
          user: u,
          blockId: createBlockMap.get(u.user_id),
        }));
      await insertParticipants(
        transaction,
        newId,
        validParticipants,
        createBlockMap
      );
    }

    // 5. Commit
    await transaction.commit();
  } catch (e) {
    try {
      await transaction.rollback();
    } catch (_) {
      /* ignore */
    }
    console.error("[reservation.create]", e);
    return res.status(500).json(err("No fue posible agendar la reunión"));
  }

  // Historial: registrar creación (no propaga errores).
  logHistory({
    reservationId: newId,
    actionType: "created",
    actionBy: req.user.userId,
    details: {
      title: cleanTitle,
      type,
      startsAt: startsDate,
      endsAt: endsDate,
    },
  });

  // ---- Fuera de la transaccion: correo + notificaciones internas ----
  if (validParticipants.length > 0) {
    const blockedUserIdSet = new Set(
      blockedParticipants.map((b) => b.user.user_id)
    );
    const autoAcceptedParticipants = validParticipants.filter(
      (u) => !blockedUserIdSet.has(u.user_id)
    );

    const room = isPhysical ? await fetchRoom(pool, parsedRoomId) : null;

    // Invitación normal solo a los auto-aceptados.
    if (autoAcceptedParticipants.length > 0) {
      notifyParticipants({
        reservationId: newId,
        reservationType: type,
        roomName: room ? room.name : "",
        roomLocation: room ? room.location : null,
        externalAddress: isExternalType ? cleanExternalAddress : null,
        meetingLink: cleanLink,
        title: cleanTitle,
        description: cleanDesc,
        startsAt: startsDate,
        endsAt: endsDate,
        organizerName: req.user.fullName,
        participants: autoAcceptedParticipants,
        action: "created",
      }).catch((e) =>
        console.error("[reservation.create] Notificacion fallo:", e.message)
      );

      createNotificationsForParticipants({
        participantIds: autoAcceptedParticipants.map((u) => u.user_id),
        reservationId: newId,
        type: "invited",
        title: "Te invitaron a una reunión",
        body: notificationBody(cleanTitle, startsAt),
      }).catch((e) =>
        console.error(
          "[reservation.create] Notificacion interna fallo:",
          e.message
        )
      );
    }

    // Invitación CON BLOQUEO a los que tienen un bloqueo personal solapado.
    if (blockedParticipants.length > 0) {
      notifyBlockedParticipants({
        reservationId: newId,
        blockedParticipants,
        title: cleanTitle,
        startsAt: startsDate,
        endsAt: endsDate,
        organizerName: req.user.fullName,
      }).catch((e) =>
        console.error(
          "[reservation.create] Notificación de bloqueo fallo:",
          e.message
        )
      );
    }
  }

  try {
    const full = await pool
      .request()
      .input("id", sql.Int, newId)
      .query(`
        SELECT ${RESERVATION_FIELDS}
        ${RESERVATION_FROM}
        WHERE r.reservation_id = @id
      `);

    const reservation = mapReservation(full.recordset[0]);
    return res.status(201).json(
      ok(
        { ...reservation, participantsNotified: validParticipants.length },
        "Reunión agendada"
      )
    );
  } catch (e) {
    console.error("[reservation.create] post-commit", e);
    // La reserva quedó creada; devolvemos lo mínimo.
    return res.status(201).json(
      ok(
        { id: newId, participantsNotified: validParticipants.length },
        "Reunión agendada"
      )
    );
  }
};

const update = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  const {
    roomId,
    startsAt,
    endsAt,
    title,
    description,
    meetingLink,
    participantIds,
    departmentIds,
    type,
    externalAddress,
    externalSubtype,
    externalCompany,
    externalMapsUrl,
    externalContact,
    virtualPlatform,
  } = req.body || {};

  let pool;
  try {
    pool = await getPool();
  } catch (e) {
    console.error("[reservation.update] No pool", e);
    return res.status(500).json(err("No fue posible actualizar la reunión"));
  }

  // Pre-validaciones (lecturas sueltas).
  const current = await pool
    .request()
    .input("id", sql.Int, id)
    .query(`
      SELECT r.reservation_id, r.reservation_type, r.room_id, r.created_by,
             r.title, r.description, r.starts_at, r.ends_at, r.status,
             r.meeting_link, r.external_address,
             r.external_subtype, r.external_company, r.external_maps_url,
             r.external_contact, r.virtual_platform,
             rm.name AS room_name
      FROM core.reservations r
      LEFT JOIN core.rooms rm ON rm.room_id = r.room_id
      WHERE r.reservation_id = @id
    `);
  if (current.recordset.length === 0) {
    return res.status(404).json(err("Reserva no encontrada"));
  }
  const row = current.recordset[0];
  if (row.status !== "active") {
    return res.status(400).json(err("No se puede modificar una reunión cancelada"));
  }
  if (new Date(row.ends_at) < new Date()) {
    return res.status(400).json(err("No se puede modificar una reunión que ya finalizó"));
  }
  if (row.created_by !== req.user.userId && req.user.role !== "admin") {
    return res.status(403).json(err("Solo el creador o un administrador puede modificar"));
  }

  // Resolver el nuevo tipo (default: mantener el actual).
  const newType = type !== undefined ? type : row.reservation_type;
  if (!VALID_TYPES.includes(newType)) {
    return res.status(400).json(err("Tipo de reunión no válido"));
  }
  const isPhysical = newType === RESERVATION_TYPES.PHYSICAL;
  const isVirtualType = newType === RESERVATION_TYPES.VIRTUAL;
  const isExternalType = newType === RESERVATION_TYPES.EXTERNAL;
  const isOfficeType = newType === RESERVATION_TYPES.OFFICE;

  // Office: el creador debe tener departamento; no se admite roomId.
  let organizerDeptIdForOffice = null;
  if (isOfficeType) {
    if (roomId != null) {
      return res
        .status(400)
        .json(err("Las reuniones de oficina no llevan sala asignada"));
    }
    const userCheck = await pool
      .request()
      .input("uid", sql.Int, row.created_by)
      .query("SELECT department_id FROM auth.users WHERE user_id = @uid");
    organizerDeptIdForOffice = userCheck.recordset[0]?.department_id ?? null;
    if (organizerDeptIdForOffice == null) {
      return res
        .status(400)
        .json(
          err(
            "El creador necesita tener un departamento asignado para reuniones de oficina"
          )
        );
    }
  }

  // Aceptamos cualquier minuto — el backend redondea al múltiplo de 5 más
  // cercano para preservar la granularidad de los slots.
  const newStart = startsAt
    ? roundToNearest5Minutes(startsAt)
    : new Date(row.starts_at);
  const newEnd = endsAt
    ? roundToNearest5Minutes(endsAt)
    : new Date(row.ends_at);
  const newTitle = title != null ? String(title).trim() : row.title;
  if (newTitle.length === 0) {
    return res.status(400).json(err("El título es obligatorio"));
  }
  if (newTitle.length > LIMITS.TITLE) {
    return res
      .status(400)
      .json(err(`El título no puede superar ${LIMITS.TITLE} caracteres`));
  }
  const newDesc =
    description != null ? String(description).trim() : row.description;
  if (newDesc && newDesc.length > LIMITS.DESCRIPTION) {
    return res
      .status(400)
      .json(
        err(`La descripción no puede superar ${LIMITS.DESCRIPTION} caracteres`)
      );
  }

  // Ubicación externa: solo aplica si el nuevo tipo es external.
  let newExternalAddress = null;
  let newExternalSubtype = null;
  let newExternalCompany = null;
  let newExternalMapsUrl = null;
  let newExternalContact = null;
  if (isExternalType) {
    if (externalAddress !== undefined) {
      newExternalAddress = String(externalAddress)
        .trim()
        .slice(0, LIMITS.EXTERNAL_ADDRESS);
    } else {
      newExternalAddress = row.external_address;
    }
    if (!newExternalAddress || newExternalAddress.length < 3) {
      return res
        .status(400)
        .json(err("Debes indicar la dirección (mínimo 3 caracteres)"));
    }
    if (newExternalAddress.length > LIMITS.EXTERNAL_ADDRESS) {
      return res
        .status(400)
        .json(
          err(
            `La dirección no puede superar ${LIMITS.EXTERNAL_ADDRESS} caracteres`
          )
        );
    }

    if (externalSubtype !== undefined) {
      if (!externalSubtype || !VALID_EXTERNAL_SUBTYPES.includes(externalSubtype)) {
        return res
          .status(400)
          .json(err("Debes elegir el tipo de actividad"));
      }
      newExternalSubtype = externalSubtype;
    } else {
      newExternalSubtype = row.external_subtype || null;
      if (!newExternalSubtype && row.reservation_type !== RESERVATION_TYPES.EXTERNAL) {
        return res
          .status(400)
          .json(err("Debes elegir el tipo de actividad"));
      }
    }

    if (externalCompany !== undefined) {
      const c = externalCompany == null ? "" : String(externalCompany).trim();
      if (c.length > 120) {
        return res
          .status(400)
          .json(err("El nombre del lugar es demasiado largo"));
      }
      newExternalCompany = c || null;
    } else {
      newExternalCompany = row.external_company || null;
    }

    if (externalMapsUrl !== undefined) {
      const u = externalMapsUrl == null ? "" : String(externalMapsUrl).trim();
      if (u.length > 500) {
        return res
          .status(400)
          .json(err("El enlace de Maps es demasiado largo"));
      }
      if (u.length > 0) {
        const urlCheck = validateUrl(u, "enlace de Maps");
        if (!urlCheck.valid) {
          return res.status(400).json(err(urlCheck.error));
        }
      }
      newExternalMapsUrl = u || null;
    } else {
      newExternalMapsUrl = row.external_maps_url || null;
    }

    if (externalContact !== undefined) {
      const c = externalContact == null ? "" : String(externalContact).trim();
      if (c.length > 120) {
        return res
          .status(400)
          .json(err("El nombre del contacto es demasiado largo"));
      }
      newExternalContact = c || null;
    } else {
      newExternalContact = row.external_contact || null;
    }
  }

  let newVirtualPlatform = null;
  if (isVirtualType) {
    if (virtualPlatform !== undefined) {
      const p = virtualPlatform == null ? "" : String(virtualPlatform).trim();
      if (p && !VIRTUAL_PLATFORMS.includes(p)) {
        return res.status(400).json(err("Plataforma inválida"));
      }
      newVirtualPlatform = p || null;
    } else {
      newVirtualPlatform = row.virtual_platform || null;
    }
  }

  // Sala: solo aplica para physical. Para virtual/external, room_id = NULL.
  let newRoomId = null;
  let newRoomName = null;
  let newRoomLocation = null;

  if (isPhysical) {
    if (roomId != null) {
      newRoomId = parseInt(roomId, 10);
    } else if (row.reservation_type === RESERVATION_TYPES.PHYSICAL) {
      newRoomId = row.room_id;
    }
    if (!Number.isInteger(newRoomId) || newRoomId <= 0) {
      return res.status(400).json(err("Debes elegir una sala"));
    }
    const roomRes = await pool
      .request()
      .input("rId", sql.Int, newRoomId)
      .query(
        "SELECT name, location, is_active FROM core.rooms WHERE room_id = @rId"
      );
    if (roomRes.recordset.length === 0 || !roomRes.recordset[0].is_active) {
      return res.status(400).json(err("Sala no disponible"));
    }
    newRoomName = roomRes.recordset[0].name;
    newRoomLocation = roomRes.recordset[0].location;
  }

  // Enlace de reunión: solo virtual.
  let newLink = isVirtualType ? row.meeting_link : null;
  if (meetingLink !== undefined) {
    const linkCheck = validateMeetingLink(meetingLink);
    if (!linkCheck.ok) {
      return res.status(400).json(err(linkCheck.msg));
    }
    newLink = isVirtualType ? linkCheck.value : null;
  }

  const validation = await validateReservation({
    roomId: newRoomId,
    startsAt: newStart,
    endsAt: newEnd,
    excludeId: id,
    pool,
    skipRoomOverlap: true,
    skipRoom: !isPhysical,
  });
  if (!validation.valid) {
    return res.status(400).json(err(validation.msg));
  }

  // Detectar cambios para historial (antes del UPDATE).
  const changes = [];
  const timeChanged =
    new Date(row.starts_at).getTime() !== newStart.getTime() ||
    new Date(row.ends_at).getTime() !== newEnd.getTime();
  if (timeChanged) {
    changes.push({
      type: "rescheduled",
      old: `${fmtDateTime(row.starts_at)} - ${fmtHora(row.ends_at)}`,
      new: `${fmtDateTime(newStart)} - ${fmtHora(newEnd)}`,
    });
  }
  if (newRoomId !== row.room_id) {
    changes.push({
      type: "room_changed",
      old: row.room_name || "—",
      new: newRoomName || "—",
    });
  }
  if (row.title !== newTitle) {
    changes.push({ type: "title_changed", old: row.title, new: newTitle });
  }
  const oldLink = row.meeting_link || null;
  if (oldLink !== newLink) {
    changes.push({ type: "link_changed", old: oldLink, new: newLink });
  }
  const typeLabels = {
    physical: "En sala",
    virtual: "Virtual",
    external: "Fuera de oficina",
    office: "Oficina del departamento",
  };
  const modalityChanged = row.reservation_type !== newType;
  if (modalityChanged) {
    changes.push({
      type: "modality_changed",
      old: typeLabels[row.reservation_type] || row.reservation_type,
      new: typeLabels[newType] || newType,
    });
  }

  // ---- Transaccion atomica ----
  const transaction = pool.transaction();
  await transaction.begin();
  let added = [];
  let updateBlockedParticipants = [];
  try {
    // 1. Solapamiento de sala fisica con UPDLOCK+HOLDLOCK (excluye esta reserva).
    //    Solo aplica si la nueva reserva es physical.
    if (isPhysical) {
      const overlapRoom = await transaction
        .request()
        .input("roomId", sql.Int, newRoomId)
        .input("startsAt", sql.DateTime2, newStart)
        .input("endsAt", sql.DateTime2, newEnd)
        .input("currentId", sql.Int, id)
        .query(`
          SELECT TOP 1 reservation_id
          FROM core.reservations WITH (UPDLOCK, HOLDLOCK)
          WHERE room_id = @roomId
            AND status = 'active'
            AND starts_at < @endsAt
            AND (
              (ended_early = 1 AND ended_at > @startsAt)
              OR (ended_early = 0 AND ends_at > @startsAt)
            )
            AND reservation_id <> @currentId
        `);
      if (overlapRoom.recordset.length > 0) {
        await transaction.rollback();
        return res
          .status(409)
          .json(
            err(
              "Alguien acaba de agendar este horario. Por favor elija otro horario o sala."
            )
          );
      }
    }

    // 1b. Solapamiento de OFICINA del departamento (excluye esta reserva).
    if (isOfficeType) {
      const overlapOffice = await transaction
        .request()
        .input("deptId", sql.Int, organizerDeptIdForOffice)
        .input("startsAt", sql.DateTime2, newStart)
        .input("endsAt", sql.DateTime2, newEnd)
        .input("currentId", sql.Int, id)
        .query(`
          SELECT TOP 1 r.title
          FROM core.reservations r WITH (UPDLOCK, HOLDLOCK)
          INNER JOIN auth.users uu ON uu.user_id = r.created_by
          WHERE r.reservation_type = 'office'
            AND r.status = 'active'
            AND uu.department_id = @deptId
            AND r.reservation_id <> @currentId
            AND r.starts_at < @endsAt
            AND (
              (r.ended_early = 1 AND r.ended_at > @startsAt)
              OR (r.ended_early = 0 AND r.ends_at > @startsAt)
            )
        `);
      if (overlapOffice.recordset.length > 0) {
        await transaction.rollback();
        return res
          .status(409)
          .json(
            err(
              `La oficina del departamento ya esta ocupada en ese horario por "${overlapOffice.recordset[0].title}"`
            )
          );
      }
    }

    // 2. Solapamiento de agenda (creador + participantes + miembros de
    //    departamentos invitados — snapshot al momento) con locks.
    const incomingIds =
      participantIds !== undefined
        ? sanitizeIds(participantIds, row.created_by)
        : null;

    let updateDeptMemberIds = [];
    if (departmentIds !== undefined) {
      try {
        const resolved = await resolveDepartmentMembers(
          pool,
          departmentIds,
          row.created_by
        );
        updateDeptMemberIds = resolved.memberIds;
      } catch (e) {
        if (e.code === "INVALID_DEPARTMENT") {
          await transaction.rollback();
          return res.status(400).json(err(e.message));
        }
        throw e;
      }
    }

    let agendaUserIds = [row.created_by];
    if (incomingIds !== null || updateDeptMemberIds.length > 0) {
      const combined = [
        ...new Set([
          ...(incomingIds || []),
          ...updateDeptMemberIds,
        ]),
      ].filter((uid) => uid !== row.created_by);
      agendaUserIds = agendaUserIds.concat(combined);
    } else if (incomingIds === null && updateDeptMemberIds.length === 0) {
      const existing = await transaction
        .request()
        .input("rId", sql.Int, id)
        .query(
          `SELECT user_id FROM core.reservation_participants WHERE reservation_id = @rId`
        );
      agendaUserIds = agendaUserIds.concat(
        existing.recordset.map((r) => r.user_id)
      );
    }
    const overlapping = await findUsersWithOverlap({
      userIds: agendaUserIds,
      startsAt: newStart,
      endsAt: newEnd,
      excludeReservationId: id,
      transaction,
    });
    if (overlapping.length > 0) {
      const msg = await buildOverlapMessage(pool, overlapping, req.user.userId);
      await transaction.rollback();
      return res.status(409).json(err(msg));
    }

    // 3. UPDATE reserva
    await transaction
      .request()
      .input("id", sql.Int, id)
      .input("type", sql.VarChar(20), newType)
      .input("room_id", sql.Int, isPhysical ? newRoomId : null)
      .input("title", sql.VarChar(150), newTitle)
      .input("description", sql.VarChar(500), newDesc)
      .input("meeting_link", sql.VarChar(500), newLink)
      .input("starts_at", sql.DateTime2, newStart)
      .input("ends_at", sql.DateTime2, newEnd)
      .input(
        "external_address",
        sql.VarChar(300),
        isExternalType ? newExternalAddress : null
      )
      .input(
        "external_subtype",
        sql.VarChar(30),
        isExternalType ? newExternalSubtype : null
      )
      .input(
        "external_company",
        sql.VarChar(120),
        isExternalType ? newExternalCompany : null
      )
      .input(
        "external_maps_url",
        sql.VarChar(500),
        isExternalType ? newExternalMapsUrl : null
      )
      .input(
        "external_contact",
        sql.VarChar(120),
        isExternalType ? newExternalContact : null
      )
      .input(
        "virtual_platform",
        sql.VarChar(20),
        isVirtualType ? newVirtualPlatform : null
      )
      .query(`
        UPDATE core.reservations SET
          reservation_type = @type,
          room_id = @room_id,
          title = @title,
          description = @description,
          meeting_link = @meeting_link,
          starts_at = @starts_at,
          ends_at = @ends_at,
          external_address = @external_address,
          external_subtype = @external_subtype,
          external_company = @external_company,
          external_maps_url = @external_maps_url,
          external_contact = @external_contact,
          virtual_platform = @virtual_platform,
          is_exception = CASE
            WHEN recurring_series_id IS NOT NULL THEN 1
            ELSE is_exception
          END
        WHERE reservation_id = @id
      `);

    // 3b. Si el horario cambió, resetear banderas de recordatorios para que
    //     el cron los reenvíe en la nueva ventana de tiempo (G3.4).
    if (timeChanged) {
      await transaction
        .request()
        .input("id", sql.Int, id)
        .query(`
          UPDATE core.reservations
          SET reminder_24h_sent = 0, reminder_15m_sent = 0
          WHERE reservation_id = @id
        `);
    }

    // 4. Registrar cambios en historial — usando la transacción para que el
    //    log y el UPDATE sean atómicos. El esquema nuevo de
    //    core.reservation_history guarda action_type + details (JSON).
    for (const ch of changes) {
      try {
        await transaction
          .request()
          .input("rId", sql.Int, id)
          .input("actionType", sql.VarChar(40), ch.type)
          .input("actionBy", sql.Int, req.user.userId)
          .input(
            "details",
            sql.NVarChar(sql.MAX),
            JSON.stringify({
              old: ch.old != null ? String(ch.old) : null,
              new: ch.new != null ? String(ch.new) : null,
            })
          )
          .query(`
            INSERT INTO core.reservation_history
              (reservation_id, action_type, action_by, details)
            VALUES (@rId, @actionType, @actionBy, @details)
          `);
      } catch (e) {
        console.error("[reservation.update.history]", e.message);
      }
    }

    // 5. Diff de colaboradores. Si vienen `departmentIds`, sus miembros
    //    (snapshot al momento del update) se suman a los participantes
    //    deseados, deduplicados con los individuales.
    if (participantIds !== undefined || departmentIds !== undefined) {
      const currentRes = await transaction
        .request()
        .input("rId", sql.Int, id)
        .query(`
          SELECT rp.user_id, u.email, u.full_name
          FROM core.reservation_participants rp
          JOIN auth.users u ON u.user_id = rp.user_id
          WHERE rp.reservation_id = @rId
        `);
      const currentIds = new Set(currentRes.recordset.map((r) => r.user_id));
      const wantedIndividualIds =
        participantIds !== undefined
          ? sanitizeIds(participantIds, req.user.userId)
          : [...currentIds];
      const wantedIds = new Set(
        [...wantedIndividualIds, ...updateDeptMemberIds].filter(
          (uid) => uid !== req.user.userId
        )
      );

      const toAdd = [...wantedIds].filter((x) => !currentIds.has(x));
      const toRemove = [...currentIds].filter((x) => !wantedIds.has(x));

      if (toRemove.length > 0) {
        const placeholders = toRemove.map((_, i) => `@r${i}`).join(",");
        const delReq = transaction.request().input("rId", sql.Int, id);
        toRemove.forEach((uid, i) => delReq.input(`r${i}`, sql.Int, uid));
        await delReq.query(
          `DELETE FROM core.reservation_participants
           WHERE reservation_id = @rId AND user_id IN (${placeholders})`
        );
      }

      if (toAdd.length > 0) {
        added = await loadActiveUsers(transaction, toAdd);
        // Detectar bloqueos personales solapados con la reunión (nuevo horario).
        let updateBlockMap = new Map();
        try {
          const blocks = await findBlocksInRange({
            userIds: added.map((u) => u.user_id),
            startsAt: newStart,
            endsAt: newEnd,
            pool: transaction,
          });
          for (const b of blocks) {
            if (!updateBlockMap.has(b.userId)) {
              updateBlockMap.set(b.userId, b.blockId);
            }
          }
        } catch (e) {
          console.error("[reservation.update] findBlocksInRange", e);
        }
        updateBlockedParticipants = added
          .filter((u) => updateBlockMap.has(u.user_id))
          .map((u) => ({
            user: u,
            blockId: updateBlockMap.get(u.user_id),
          }));
        await insertParticipants(transaction, id, added, updateBlockMap);
      }
    }

    // 6. Commit
    await transaction.commit();
  } catch (e) {
    try {
      await transaction.rollback();
    } catch (_) {
      /* ignore */
    }
    console.error("[reservation.update]", e);
    return res.status(500).json(err("No fue posible actualizar la reunión"));
  }

    // ---- Notificaciones ----
    // coreChanged = horario, sala, modalidad o link cambiaron.
    const coreChanged = changes.some((c) =>
      ["rescheduled", "room_changed", "link_changed", "modality_changed"].includes(
        c.type
      )
    );

    // (a) Notificar a los NUEVOS participantes como invitacion normal (created).
    if (added.length > 0) {
      const updateBlockedUserIdSet = new Set(
        updateBlockedParticipants.map((b) => b.user.user_id)
      );
      const addedAutoAccepted = added.filter(
        (u) => !updateBlockedUserIdSet.has(u.user_id)
      );

      if (addedAutoAccepted.length > 0) {
        notifyParticipants({
          reservationId: id,
          reservationType: newType,
          roomName: newRoomName,
          roomLocation: newRoomLocation,
          externalAddress: isExternalType ? newExternalAddress : null,
          meetingLink: newLink,
          title: newTitle,
          description: newDesc,
          startsAt: newStart,
          endsAt: newEnd,
          organizerName: req.user.fullName,
          participants: addedAutoAccepted,
          action: "created",
        }).catch((e) =>
          console.error("[reservation.update] Notificacion (nuevos) fallo:", e.message)
        );

        createNotificationsForParticipants({
          participantIds: addedAutoAccepted.map((u) => u.user_id),
          reservationId: id,
          type: "invited",
          title: "Te invitaron a una reunión",
          body: notificationBody(newTitle, newStart),
        }).catch((e) =>
          console.error("[reservation.update] Notificacion interna (nuevos) fallo:", e.message)
        );
      }

      if (updateBlockedParticipants.length > 0) {
        notifyBlockedParticipants({
          reservationId: id,
          blockedParticipants: updateBlockedParticipants,
          title: newTitle,
          startsAt: newStart,
          endsAt: newEnd,
          organizerName: req.user.fullName,
        }).catch((e) =>
          console.error(
            "[reservation.update] Notificacion bloqueo fallo:",
            e.message
          )
        );
      }
    }

    // (b) Notificar a los participantes existentes si hubo cambio core.
    if (coreChanged) {
      const addedIds = added.map((u) => u.user_id);
      const remainingReq = pool.request().input("rId", sql.Int, id);
      let where = `rp.reservation_id = @rId`;
      if (addedIds.length > 0) {
        const placeholders = addedIds.map((_, i) => `@k${i}`).join(",");
        addedIds.forEach((uid, i) => remainingReq.input(`k${i}`, sql.Int, uid));
        where += ` AND rp.user_id NOT IN (${placeholders})`;
      }
      const remaining = await remainingReq.query(`
        SELECT rp.user_id, u.email, u.full_name
        FROM core.reservation_participants rp
        JOIN auth.users u ON u.user_id = rp.user_id
        WHERE ${where} AND u.is_active = 1
      `);
      if (remaining.recordset.length > 0) {
        notifyParticipants({
          reservationId: id,
          reservationType: newType,
          roomName: newRoomName,
          roomLocation: newRoomLocation,
          externalAddress: isExternalType ? newExternalAddress : null,
          meetingLink: newLink,
          title: newTitle,
          description: newDesc,
          startsAt: newStart,
          endsAt: newEnd,
          organizerName: req.user.fullName,
          participants: remaining.recordset,
          action: "rescheduled",
          changes,
        }).catch((e) =>
          console.error("[reservation.update] Notificacion (rescheduled) fallo:", e.message)
        );

        const timeChanged = changes.some((c) => c.type === "rescheduled");
        createNotificationsForParticipants({
          participantIds: remaining.recordset.map((u) => u.user_id),
          reservationId: id,
          type: timeChanged ? "rescheduled" : "updated",
          title: timeChanged
            ? "Una reunión fue reagendada"
            : "Cambios en una reunión",
          body: notificationBody(newTitle, newStart),
        }).catch((e) =>
          console.error("[reservation.update] Notificacion interna fallo:", e.message)
        );
      }
    }

    // (c) Invitados externos notificados previamente: notificar el reagendado.
    if (coreChanged) {
      try {
        const guestsRes = await pool
          .request()
          .input("rId", sql.Int, id)
          .query(`
            SELECT email, display_name AS displayName
            FROM core.reservation_external_guests
            WHERE reservation_id = @rId AND notified = 1
          `);
        if (guestsRes.recordset.length > 0) {
          const guestLocation = isVirtualType
            ? "Reunión virtual"
            : isExternalType
              ? `Fuera de oficina${newExternalAddress ? ` · ${newExternalAddress}` : ""}`
              : newRoomLocation
                ? `${newRoomName} · ${newRoomLocation}`
                : newRoomName;
          for (const g of guestsRes.recordset) {
            sendGuestRescheduledEmail({
              to: g.email,
              guestName: g.displayName || g.email,
              reservationTitle: newTitle,
              oldStartsAt: row.starts_at,
              oldEndsAt: row.ends_at,
              newStartsAt: newStart,
              newEndsAt: newEnd,
              location: guestLocation,
              meetingLink: newLink,
              organizerName: req.user.fullName,
              organizerEmail: req.user.email,
            }).catch((e) =>
              console.error(
                "[reservation.update] guest email fallo:",
                e.message
              )
            );
          }
        }
      } catch (e) {
        console.error("[reservation.update] guests query fallo:", e.message);
      }
    }

  try {
    const full = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        SELECT ${RESERVATION_FIELDS}
        ${RESERVATION_FROM}
        WHERE r.reservation_id = @id
      `);
    return res.json(
      ok(
        { ...mapReservation(full.recordset[0]), changes: changes.length },
        "Reunión actualizada"
      )
    );
  } catch (e) {
    console.error("[reservation.update] post-commit", e);
    return res.json(
      ok({ id, changes: changes.length }, "Reunión actualizada")
    );
  }
};

const cancel = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));

  const reasonRaw = (req.body && req.body.reason) || "";
  const reason = String(reasonRaw).trim();
  // Motivo opcional. Si se provee, validamos longitud máxima.
  if (reason.length > LIMITS.REASON) {
    return res
      .status(400)
      .json(err(`El motivo no puede superar ${LIMITS.REASON} caracteres`));
  }

  try {
    const pool = await getPool();
    const current = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        SELECT
          r.reservation_id, r.reservation_type, r.title, r.description,
          r.starts_at, r.ends_at, r.created_by, r.meeting_link, r.status,
          r.external_address,
          ro.name AS room_name, ro.location AS room_location,
          u.full_name AS creator_name
        FROM core.reservations r
        LEFT JOIN core.rooms ro ON ro.room_id = r.room_id
        JOIN auth.users u       ON u.user_id  = r.created_by
        WHERE r.reservation_id = @id
      `);
    if (current.recordset.length === 0) {
      return res.status(404).json(err("Reserva no encontrada"));
    }
    const row = current.recordset[0];
    if (row.status !== "active") {
      return res.status(400).json(err("La reunión ya estaba cancelada"));
    }
    if (row.created_by !== req.user.userId && req.user.role !== "admin") {
      return res
        .status(403)
        .json(err("Solo el organizador o un administrador puede cancelar"));
    }
    if (new Date(row.ends_at) <= new Date()) {
      return res
        .status(400)
        .json(err("No se puede cancelar una reunión que ya finalizó"));
    }

    // Detectar si la reunion esta en curso al momento de cancelar.
    const now = new Date();
    const startsAt = new Date(row.starts_at);
    const endsAt = new Date(row.ends_at);
    const inProgress = now >= startsAt && now < endsAt;

    // Traer participantes activos ANTES de cancelar para notificarlos.
    const partsRes = await pool
      .request()
      .input("rId", sql.Int, id)
      .query(`
        SELECT rp.user_id, u.email, u.full_name
        FROM core.reservation_participants rp
        JOIN auth.users u ON u.user_id = rp.user_id
        WHERE rp.reservation_id = @rId AND rp.status = 'active'
      `);

    // 1) Persistir la cancelacion. Es el paso CRITICO: si falla, devolvemos 500.
    try {
      await pool
        .request()
        .input("id", sql.Int, id)
        .input("cancelledBy", sql.Int, req.user.userId)
        .input("reason", sql.VarChar(500), reason)
        .query(`
          UPDATE core.reservations
          SET status = 'cancelled',
              cancelled_at = SYSDATETIME(),
              cancelled_by = @cancelledBy,
              cancel_reason = @reason
          WHERE reservation_id = @id
        `);
    } catch (e) {
      console.error("[reservation.cancel] UPDATE fallo:", e);
      return res
        .status(500)
        .json(err("No fue posible cancelar la reunión"));
    }

    // 2) Historial: la cancelacion YA persistio. logHistory loguea pero no
    //    propaga, porque la reunion sí quedó cancelada.
    logHistory({
      reservationId: id,
      actionType: inProgress ? "cancelled_in_progress" : "cancelled",
      actionBy: req.user.userId,
      details: { reason, inProgress },
      pool,
    });

    if (partsRes.recordset.length > 0) {
      notifyParticipants({
        reservationId: id,
        reservationType: row.reservation_type,
        roomName: row.room_name,
        roomLocation: row.room_location,
        externalAddress: row.external_address,
        meetingLink: row.meeting_link,
        title: row.title,
        description: row.description,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        organizerName: row.creator_name,
        participants: partsRes.recordset,
        action: "cancelled",
        cancelReason: reason,
        cancelledInProgress: inProgress,
      }).catch((e) =>
        console.error("[reservation.cancel] Notificacion fallo:", e.message)
      );

      const internalTitle = inProgress
        ? "Reunión cancelada en curso"
        : "Reunión cancelada";
      createNotificationsForParticipants({
        participantIds: partsRes.recordset.map((u) => u.user_id),
        reservationId: id,
        type: "cancelled",
        title: internalTitle,
        body: `${row.title} · Motivo: "${reason}"`,
      }).catch((e) =>
        console.error(
          "[reservation.cancel] Notificacion interna fallo:",
          e.message
        )
      );
    }

    // Invitados externos notificados previamente.
    try {
      const guestsRes = await pool
        .request()
        .input("rId", sql.Int, id)
        .query(`
          SELECT email, display_name AS displayName
          FROM core.reservation_external_guests
          WHERE reservation_id = @rId AND notified = 1
        `);
      for (const g of guestsRes.recordset) {
        sendGuestCancellationEmail({
          to: g.email,
          guestName: g.displayName || g.email,
          reservationTitle: row.title,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          reason,
          organizerName: row.creator_name,
          organizerEmail: req.user.email,
        }).catch((e) =>
          console.error("[reservation.cancel] guest email fallo:", e.message)
        );
      }
    } catch (e) {
      console.error("[reservation.cancel] guests query fallo:", e.message);
    }

    return res.json(ok({ id, inProgress }, "Reunión cancelada"));
  } catch (e) {
    console.error("[reservation.cancel]", e);
    return res.status(500).json(err("No fue posible cancelar la reunión"));
  }
};

const getVirtual = async (req, res) => {
  const userId = req.user.userId;
  const date = String(req.query.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json(err("Fecha no valida"));
  }
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("me", sql.Int, userId)
      .input("from", sql.DateTime2, new Date(`${date}T00:00:00`))
      .input("to", sql.DateTime2, new Date(`${date}T23:59:59`))
      .query(`
        SELECT
          r.reservation_id AS id,
          r.reservation_type AS type,
          r.room_id        AS roomId,
          NULL             AS roomName,
          NULL             AS roomColor,
          NULL             AS roomIcon,
          NULL             AS roomDescription,
          r.external_address AS externalAddress,
          r.external_subtype AS externalSubtype,
          r.external_company AS externalCompany,
          r.external_maps_url AS externalMapsUrl,
          r.external_contact AS externalContact,
          r.virtual_platform AS virtualPlatform,
          r.meeting_link   AS meetingLink,
          r.ended_early    AS endedEarly,
          r.ended_at       AS endedAt,
          r.ended_by       AS endedById,
          r.end_early_reason AS endEarlyReason,
          eb.full_name     AS endedByName,
          r.created_by     AS createdBy,
          u.full_name      AS userFullName,
          u.email          AS userEmail,
          u.avatar_url     AS userAvatarUrl,
          r.title,
          r.starts_at      AS startsAt,
          r.ends_at        AS endsAt,
          r.status,
          (
            SELECT COUNT(*) FROM core.reservation_participants rp
            WHERE rp.reservation_id = r.reservation_id
              AND rp.status = 'active'
          ) AS participantsCount,
          CASE
            WHEN r.created_by = @me OR EXISTS (
              SELECT 1 FROM core.reservation_participants rp
              WHERE rp.reservation_id = r.reservation_id
                AND rp.user_id = @me AND rp.status = 'active'
            ) THEN 1
            ELSE 0
          END AS isMine
        FROM core.reservations r
        JOIN auth.users u       ON u.user_id  = r.created_by
        LEFT JOIN auth.users eb ON eb.user_id = r.ended_by
        WHERE r.reservation_type = 'virtual'
          AND r.status = 'active'
          AND r.starts_at >= @from AND r.starts_at <= @to
        ORDER BY r.starts_at
      `);
    const items = result.recordset.map((r) => ({
      id: r.id,
      type: r.type,
      roomId: r.roomId,
      roomName: r.roomName,
      roomColor: r.roomColor || null,
      roomIcon: r.roomIcon || null,
      roomDescription: r.roomDescription || null,
      externalAddress: r.externalAddress || null,
      externalSubtype: r.externalSubtype || null,
      externalCompany: r.externalCompany || null,
      externalMapsUrl: r.externalMapsUrl || null,
      externalContact: r.externalContact || null,
      virtualPlatform: r.virtualPlatform || null,
      meetingLink: r.meetingLink || null,
      endedEarly: !!r.endedEarly,
      endedAt: r.endedAt || null,
      endedById: r.endedById != null ? r.endedById : null,
      endedByName: r.endedByName || null,
      endEarlyReason: r.endEarlyReason || null,
      createdBy: r.createdBy,
      userFullName: r.userFullName,
      userEmail: r.userEmail,
      userAvatarUrl: r.userAvatarUrl,
      title: r.title,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      status: r.status,
      participantsCount: r.participantsCount != null ? r.participantsCount : 0,
      isMine: !!r.isMine,
    }));
    await attachParticipants(pool, items);
    return res.json(ok(items, "OK"));
  } catch (e) {
    console.error("[reservation.getVirtual]", e);
    return res.status(500).json(err("No fue posible cargar las reuniones virtuales"));
  }
};

// Reuniones "fuera de oficina" del día — espejo de getVirtual para el carril
// del dashboard. Devuelve todas las externas activas de la fecha.
const getExternal = async (req, res) => {
  const userId = req.user.userId;
  const date = String(req.query.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json(err("Fecha no valida"));
  }
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("me", sql.Int, userId)
      .input("from", sql.DateTime2, new Date(`${date}T00:00:00`))
      .input("to", sql.DateTime2, new Date(`${date}T23:59:59`))
      .query(`
        SELECT
          r.reservation_id AS id,
          r.reservation_type AS type,
          r.room_id        AS roomId,
          NULL             AS roomName,
          NULL             AS roomColor,
          NULL             AS roomIcon,
          NULL             AS roomDescription,
          r.external_address AS externalAddress,
          r.external_subtype AS externalSubtype,
          r.external_company AS externalCompany,
          r.external_maps_url AS externalMapsUrl,
          r.external_contact AS externalContact,
          r.virtual_platform AS virtualPlatform,
          r.meeting_link   AS meetingLink,
          r.ended_early    AS endedEarly,
          r.ended_at       AS endedAt,
          r.ended_by       AS endedById,
          r.end_early_reason AS endEarlyReason,
          eb.full_name     AS endedByName,
          r.created_by     AS createdBy,
          u.full_name      AS userFullName,
          u.email          AS userEmail,
          u.avatar_url     AS userAvatarUrl,
          r.title,
          r.starts_at      AS startsAt,
          r.ends_at        AS endsAt,
          r.status,
          (
            SELECT COUNT(*) FROM core.reservation_participants rp
            WHERE rp.reservation_id = r.reservation_id
              AND rp.status = 'active'
          ) AS participantsCount,
          CASE
            WHEN r.created_by = @me OR EXISTS (
              SELECT 1 FROM core.reservation_participants rp
              WHERE rp.reservation_id = r.reservation_id
                AND rp.user_id = @me AND rp.status = 'active'
            ) THEN 1
            ELSE 0
          END AS isMine
        FROM core.reservations r
        JOIN auth.users u       ON u.user_id  = r.created_by
        LEFT JOIN auth.users eb ON eb.user_id = r.ended_by
        WHERE r.reservation_type = 'external'
          AND r.status = 'active'
          AND r.starts_at >= @from AND r.starts_at <= @to
        ORDER BY r.starts_at
      `);
    const items = result.recordset.map((r) => ({
      id: r.id,
      type: r.type,
      roomId: r.roomId,
      roomName: r.roomName,
      roomColor: r.roomColor || null,
      roomIcon: r.roomIcon || null,
      roomDescription: r.roomDescription || null,
      externalAddress: r.externalAddress || null,
      externalSubtype: r.externalSubtype || null,
      externalCompany: r.externalCompany || null,
      externalMapsUrl: r.externalMapsUrl || null,
      externalContact: r.externalContact || null,
      virtualPlatform: r.virtualPlatform || null,
      meetingLink: r.meetingLink || null,
      endedEarly: !!r.endedEarly,
      endedAt: r.endedAt || null,
      endedById: r.endedById != null ? r.endedById : null,
      endedByName: r.endedByName || null,
      endEarlyReason: r.endEarlyReason || null,
      createdBy: r.createdBy,
      userFullName: r.userFullName,
      userEmail: r.userEmail,
      userAvatarUrl: r.userAvatarUrl,
      title: r.title,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      status: r.status,
      participantsCount: r.participantsCount != null ? r.participantsCount : 0,
      isMine: !!r.isMine,
    }));
    await attachParticipants(pool, items);
    return res.json(ok(items, "OK"));
  } catch (e) {
    console.error("[reservation.getExternal]", e);
    return res
      .status(500)
      .json(err("No fue posible cargar las reuniones externas"));
  }
};

const getWeek = async (req, res) => {
  const from = String((req.query && req.query.from) || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return res.status(400).json(err("Fecha inicial no valida"));
  }

  try {
    const pool = await getPool();
    const fromDate = new Date(`${from}T00:00:00`);
    const toDate = new Date(`${from}T00:00:00`);
    toDate.setDate(toDate.getDate() + 7);

    const result = await pool
      .request()
      .input("from", sql.DateTime2, fromDate)
      .input("to", sql.DateTime2, toDate)
      .input("me", sql.Int, req.user.userId)
      .query(`
        SELECT
          r.reservation_id AS id,
          r.reservation_type AS type,
          r.room_id        AS roomId,
          ro.name          AS roomName,
          ro.color_hex     AS roomColor,
          ro.icon_name     AS roomIcon,
          ro.description   AS roomDescription,
          r.external_address AS externalAddress,
          r.external_subtype AS externalSubtype,
          r.external_company AS externalCompany,
          r.external_maps_url AS externalMapsUrl,
          r.external_contact AS externalContact,
          r.virtual_platform AS virtualPlatform,
          r.ended_early    AS endedEarly,
          r.ended_at       AS endedAt,
          r.ended_by       AS endedById,
          r.end_early_reason AS endEarlyReason,
          eb.full_name     AS endedByName,
          r.created_by     AS createdBy,
          u.full_name      AS userFullName,
          u.email          AS userEmail,
          u.avatar_url     AS userAvatarUrl,
          r.title,
          r.starts_at      AS startsAt,
          r.ends_at        AS endsAt,
          r.status,
          r.meeting_link   AS meetingLink,
          CASE WHEN r.reservation_type = 'office' THEN dpt.office_name ELSE NULL END AS officeName,
          CASE WHEN r.reservation_type = 'office' THEN dpt.department_id ELSE NULL END AS officeDepartmentId,
          CASE
            WHEN r.created_by = @me OR EXISTS (
              SELECT 1 FROM core.reservation_participants rp
              WHERE rp.reservation_id = r.reservation_id
                AND rp.user_id = @me AND rp.status = 'active'
            ) THEN 1
            ELSE 0
          END AS isMine,
          (
            SELECT COUNT(*) FROM core.reservation_participants rp
            WHERE rp.reservation_id = r.reservation_id AND rp.status = 'active'
          ) AS participantsCount
        FROM core.reservations r
        LEFT JOIN core.rooms ro ON ro.room_id = r.room_id
        JOIN auth.users u       ON u.user_id  = r.created_by
        LEFT JOIN auth.departments dpt ON dpt.department_id = u.department_id
        LEFT JOIN auth.users eb ON eb.user_id = r.ended_by
        WHERE r.status = 'active'
          AND r.starts_at >= @from AND r.starts_at < @to
          AND r.reservation_type IN ('physical', 'virtual', 'external', 'office')
        ORDER BY r.starts_at
      `);

    const items = result.recordset.map((r) => ({
      id: r.id,
      type: r.type,
      roomId: r.roomId,
      roomName: r.roomName || null,
      roomColor: r.roomColor || null,
      roomIcon: r.roomIcon || null,
      roomDescription: r.roomDescription || null,
      externalAddress: r.externalAddress || null,
      externalSubtype: r.externalSubtype || null,
      externalCompany: r.externalCompany || null,
      externalMapsUrl: r.externalMapsUrl || null,
      externalContact: r.externalContact || null,
      virtualPlatform: r.virtualPlatform || null,
      endedEarly: !!r.endedEarly,
      endedAt: r.endedAt || null,
      endedById: r.endedById != null ? r.endedById : null,
      endedByName: r.endedByName || null,
      endEarlyReason: r.endEarlyReason || null,
      createdBy: r.createdBy,
      userFullName: r.userFullName,
      userEmail: r.userEmail,
      userAvatarUrl: r.userAvatarUrl,
      title: r.title,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      status: r.status,
      meetingLink: r.meetingLink || null,
      officeName: r.officeName || null,
      officeDepartmentId:
        r.officeDepartmentId != null ? r.officeDepartmentId : null,
      isMine: !!r.isMine,
      participantsCount: r.participantsCount != null ? r.participantsCount : 0,
    }));

    await attachParticipants(pool, items);
    return res.json(ok(items, "OK"));
  } catch (e) {
    console.error("[reservation.getWeek]", e);
    return res
      .status(500)
      .json(err("No fue posible cargar las reuniones de la semana"));
  }
};

const getHistory = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("rId", sql.Int, id)
      .query(`
        SELECT
          h.history_id   AS id,
          h.action_type  AS actionType,
          h.details      AS details,
          h.action_at    AS actionAt,
          h.action_by    AS actionBy,
          u.full_name    AS actionByName,
          u.email        AS actionByEmail,
          u.avatar_url   AS actionByAvatarUrl
        FROM core.reservation_history h
        JOIN auth.users u ON u.user_id = h.action_by
        WHERE h.reservation_id = @rId
        ORDER BY h.action_at DESC
      `);
    // Mantener compatibilidad con el frontend actual (changeType/oldValue/newValue)
    // mientras migra. Parseamos details JSON si existe.
    const items = result.recordset.map((r) => {
      let parsed = null;
      if (r.details) {
        try {
          parsed = JSON.parse(r.details);
        } catch {
          parsed = null;
        }
      }
      return {
        id: r.id,
        actionType: r.actionType,
        // Aliases legacy para el modal de detalle.
        changeType: r.actionType,
        oldValue: parsed && parsed.old != null ? parsed.old : null,
        newValue: parsed && parsed.new != null ? parsed.new : null,
        details: parsed,
        actionAt: r.actionAt,
        changedAt: r.actionAt,
        actionBy: r.actionBy,
        changedBy: r.actionBy,
        actionByName: r.actionByName,
        changedByName: r.actionByName,
        actionByEmail: r.actionByEmail,
        changedByEmail: r.actionByEmail,
        actionByAvatarUrl: r.actionByAvatarUrl,
        changedByAvatarUrl: r.actionByAvatarUrl,
      };
    });
    return res.json(ok(items, "OK"));
  } catch (e) {
    console.error("[reservation.getHistory]", e);
    return res.status(500).json(err("No fue posible cargar el historial"));
  }
};

// GET /api/reservations/history — Lista paginada de eventos del sistema.
// - Admin: ve todos los eventos.
// - Usuario normal: ve solo eventos donde participó (creador, participante o
//   actor de la acción).
const listHistory = async (req, res) => {
  const isAdmin = req.user.role === "admin";
  const userId = req.user.userId;

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, parseInt(req.query.pageSize, 10) || 20)
  );
  const offset = (page - 1) * pageSize;

  const action = req.query.action ? String(req.query.action).trim() : "";
  const dateFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : null;
  const dateTo = req.query.dateTo ? new Date(req.query.dateTo) : null;
  const search = req.query.search ? String(req.query.search).trim() : "";

  try {
    const pool = await getPool();
    const where = [];

    if (!isAdmin) {
      where.push(`(
        h.action_by = @userId
        OR EXISTS (
          SELECT 1 FROM core.reservations r2
          WHERE r2.reservation_id = h.reservation_id
            AND r2.created_by = @userId
        )
        OR EXISTS (
          SELECT 1 FROM core.reservation_participants p
          WHERE p.reservation_id = h.reservation_id
            AND p.user_id = @userId
        )
      )`);
    }
    if (action) where.push("h.action_type = @action");
    if (dateFrom && !isNaN(dateFrom.getTime()))
      where.push("h.action_at >= @dateFrom");
    if (dateTo && !isNaN(dateTo.getTime()))
      where.push("h.action_at <= @dateTo");
    if (search) {
      where.push(`(
        r.title COLLATE Latin1_General_CI_AI LIKE @search COLLATE Latin1_General_CI_AI
        OR u.full_name COLLATE Latin1_General_CI_AI LIKE @search COLLATE Latin1_General_CI_AI
      )`);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const buildReq = () => {
      const r = pool.request();
      if (!isAdmin) r.input("userId", sql.Int, userId);
      if (action) r.input("action", sql.VarChar(40), action);
      if (dateFrom && !isNaN(dateFrom.getTime()))
        r.input("dateFrom", sql.DateTime2, dateFrom);
      if (dateTo && !isNaN(dateTo.getTime()))
        r.input("dateTo", sql.DateTime2, dateTo);
      if (search) r.input("search", sql.NVarChar(200), `%${search}%`);
      return r;
    };

    const countReq = buildReq();
    const countRes = await countReq.query(`
      SELECT COUNT(*) AS total
      FROM core.reservation_history h
      JOIN core.reservations r ON r.reservation_id = h.reservation_id
      JOIN auth.users u        ON u.user_id        = h.action_by
      ${whereClause}
    `);
    const total = countRes.recordset[0]?.total || 0;

    const itemsReq = buildReq()
      .input("offset", sql.Int, offset)
      .input("pageSize", sql.Int, pageSize);
    const itemsRes = await itemsReq.query(`
      SELECT
        h.history_id      AS id,
        h.reservation_id  AS reservationId,
        h.action_type     AS actionType,
        h.action_at       AS actionAt,
        h.details         AS details,
        u.user_id         AS actionById,
        u.full_name       AS actionByName,
        u.email           AS actionByEmail,
        u.avatar_url      AS actionByAvatarUrl,
        r.title           AS reservationTitle,
        r.starts_at       AS reservationStartsAt,
        r.reservation_type AS reservationType,
        r.status          AS reservationStatus
      FROM core.reservation_history h
      JOIN core.reservations r ON r.reservation_id = h.reservation_id
      JOIN auth.users u        ON u.user_id        = h.action_by
      ${whereClause}
      ORDER BY h.action_at DESC
      OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY
    `);

    const items = itemsRes.recordset.map((r) => {
      let parsed = null;
      if (r.details) {
        try {
          parsed = JSON.parse(r.details);
        } catch {
          parsed = null;
        }
      }
      return { ...r, details: parsed };
    });

    return res.json(
      ok(
        {
          items,
          total,
          page,
          pageSize,
          hasMore: offset + items.length < total,
        },
        "OK"
      )
    );
  } catch (e) {
    console.error("[reservation.listHistory]", e);
    return res
      .status(500)
      .json(err("No fue posible cargar los registros"));
  }
};

const leaveReservation = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  const userId = req.user.userId;
  const reason = String((req.body && req.body.reason) || "").trim();

  if (reason.length < 5) {
    return res
      .status(400)
      .json(err("Debes indicar un motivo (al menos 5 caracteres)"));
  }
  if (reason.length > LIMITS.REASON) {
    return res
      .status(400)
      .json(err(`El motivo no puede superar ${LIMITS.REASON} caracteres`));
  }

  try {
    const pool = await getPool();

    // 1. Verificar que existe como participante activo
    const partRes = await pool
      .request()
      .input("rId", sql.Int, id)
      .input("uId", sql.Int, userId)
      .query(`
        SELECT rp.participant_id, rp.status
        FROM core.reservation_participants rp
        WHERE rp.reservation_id = @rId AND rp.user_id = @uId
      `);
    if (partRes.recordset.length === 0) {
      return res.status(404).json(err("No participas en esta reunión"));
    }
    if (partRes.recordset[0].status === "cancelled") {
      return res.status(400).json(err("Ya cancelaste tu participación"));
    }

    // 2. Datos de la reunion para notificaciones
    const dataRes = await pool
      .request()
      .input("rId", sql.Int, id)
      .input("uId", sql.Int, userId)
      .query(`
        SELECT
          r.title,
          r.created_by AS createdBy,
          r.starts_at  AS startsAt,
          r.ends_at    AS endsAt,
          r.status     AS reservationStatus,
          u.full_name  AS userFullName,
          u.email      AS userEmail,
          uo.full_name AS organizerName,
          uo.email     AS organizerEmail
        FROM core.reservations r
        JOIN auth.users u  ON u.user_id  = @uId
        JOIN auth.users uo ON uo.user_id = r.created_by
        WHERE r.reservation_id = @rId
      `);
    if (dataRes.recordset.length === 0) {
      return res.status(404).json(err("Reunión no encontrada"));
    }
    const reunion = dataRes.recordset[0];
    if (reunion.reservationStatus !== "active") {
      return res.status(400).json(err("La reunión ya no esta activa"));
    }
    if (new Date(reunion.endsAt) <= new Date()) {
      return res
        .status(400)
        .json(err("No se puede salir de una reunión que ya finalizó"));
    }

    // Distinguir si la salida ocurrió mientras la reunión estaba en curso.
    const nowAt = new Date();
    const inProgress =
      new Date(reunion.startsAt) <= nowAt && nowAt < new Date(reunion.endsAt);

    // 3. Actualizar status del participante
    await pool
      .request()
      .input("rId", sql.Int, id)
      .input("uId", sql.Int, userId)
      .input("reason", sql.VarChar(500), reason)
      .query(`
        UPDATE core.reservation_participants
        SET status = 'cancelled',
            cancelled_at = SYSDATETIME(),
            cancel_reason = @reason
        WHERE reservation_id = @rId AND user_id = @uId
      `);

    // 4. Registrar en historial
    const displayName = reunion.userFullName || reunion.userEmail;
    await logHistory({
      reservationId: id,
      actionType: "participant_cancelled",
      actionBy: userId,
      details: { participantName: displayName, reason, inProgress },
      pool,
    });

    // 5. Notificar a creador + otros participantes activos (dedupe).
    const otherPartsRes = await pool
      .request()
      .input("rId", sql.Int, id)
      .input("uId", sql.Int, userId)
      .query(`
        SELECT rp.user_id
        FROM core.reservation_participants rp
        WHERE rp.reservation_id = @rId
          AND rp.status = 'active'
          AND rp.user_id <> @uId
      `);
    const recipientIds = new Set([reunion.createdBy]);
    for (const r of otherPartsRes.recordset) recipientIds.add(r.user_id);
    recipientIds.delete(userId); // no notificar a quien se va

    const title = inProgress
      ? `${displayName} salió de una reunión en curso`
      : `${displayName} canceló su participación`;
    const body = `${reunion.title} · Motivo: "${reason}"`;
    for (const recipientId of recipientIds) {
      createNotification({
        userId: recipientId,
        reservationId: id,
        type: "participant_cancelled",
        title,
        body,
      }).catch((e) =>
        console.error("[reservation.leave] Notificacion fallo:", e.message)
      );
    }

    // 6. Correo al organizador (no propaga errores).
    sendParticipationCancelledEmail({
      organizerEmail: reunion.organizerEmail,
      organizerName: reunion.organizerName || reunion.organizerEmail,
      cancellerName: displayName,
      cancellerEmail: reunion.userEmail,
      reservationTitle: reunion.title,
      startsAt: reunion.startsAt,
      endsAt: reunion.endsAt,
      reason,
      inProgress,
    }).catch((e) =>
      console.error("[reservation.leave] Correo al organizador fallo:", e.message)
    );

    return res.json(
      ok({ reservationId: id }, "Saliste de la reunión")
    );
  } catch (e) {
    console.error("[reservation.leave]", e);
    return res.status(500).json(err("No fue posible salir de la reunión"));
  }
};

// ============================================================================
//                ASISTENCIA  (G2)
// ============================================================================

const getAttendance = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();

    // ¿El consultante es el organizador (o admin)? Lo necesitamos para decidir
    // si exponer el texto completo de la justificación.
    const meta = await pool
      .request()
      .input("rId", sql.Int, id)
      .query(
        `SELECT created_by AS createdBy FROM core.reservations WHERE reservation_id = @rId`
      );
    const isOrganizer =
      meta.recordset.length > 0 &&
      (meta.recordset[0].createdBy === req.user.userId ||
        req.user.role === "admin");

    const result = await pool
      .request()
      .input("rId", sql.Int, id)
      .query(`
        SELECT
          rp.user_id          AS userId,
          u.full_name         AS fullName,
          u.email,
          u.avatar_url        AS avatarUrl,
          rp.invitation_status AS invitationStatus,
          ra.attendance_id    AS attendanceId,
          ra.attended,
          ra.absence_reason   AS absenceReason,
          ra.marked_at        AS markedAt
        FROM core.reservation_participants rp
        JOIN auth.users u ON u.user_id = rp.user_id
        LEFT JOIN core.reservation_attendance ra
          ON ra.reservation_id = rp.reservation_id
          AND ra.user_id = rp.user_id
        WHERE rp.reservation_id = @rId
          AND rp.status = 'active'
        ORDER BY u.full_name, u.email
      `);

    // Privacidad: el detalle del motivo (especialmente auto-justificación con
    // nombre del bloqueo personal) solo se expone al organizador o admin.
    // El resto ve un texto genérico "Justificado" si hubo motivo.
    const items = result.recordset.map((row) => {
      const isAutoJustified =
        typeof row.absenceReason === "string" &&
        row.absenceReason.startsWith("[Justificado automáticamente]");
      let visibleReason = row.absenceReason;
      if (!isOrganizer && row.absenceReason) {
        visibleReason = isAutoJustified ? "Justificado" : "Justificado";
      }
      return {
        ...row,
        absenceReason: visibleReason,
        autoJustified: isAutoJustified,
      };
    });
    return res.json(ok(items, "OK"));
  } catch (e) {
    console.error("[reservation.getAttendance]", e);
    return res
      .status(500)
      .json(err("No fue posible cargar la asistencia"));
  }
};

const setAttendance = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  const { userId, attended, absenceReason } = req.body || {};
  if (typeof attended !== "boolean") {
    return res.status(400).json(err("Debes indicar si asistió o no"));
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json(err("Colaborador no válido"));
  }
  const cleanReason =
    !attended && absenceReason ? String(absenceReason).trim() : null;
  if (cleanReason && cleanReason.length > LIMITS.ABSENCE_REASON) {
    return res
      .status(400)
      .json(
        err(
          `El motivo no puede superar ${LIMITS.ABSENCE_REASON} caracteres`
        )
      );
  }

  try {
    const pool = await getPool();
    const permRes = await pool
      .request()
      .input("rId", sql.Int, id)
      .query(`
        SELECT created_by AS createdBy, starts_at AS startsAt,
               ends_at AS endsAt, status
        FROM core.reservations WHERE reservation_id = @rId
      `);
    if (permRes.recordset.length === 0) {
      return res.status(404).json(err("Reunión no encontrada"));
    }
    const reunion = permRes.recordset[0];
    if (
      reunion.createdBy !== req.user.userId &&
      req.user.role !== "admin"
    ) {
      return res
        .status(403)
        .json(err("Solo el organizador puede marcar asistencia"));
    }
    if (reunion.status !== "active") {
      return res
        .status(400)
        .json(err("No se puede marcar asistencia en una reunión cancelada"));
    }
    const now = new Date();
    const startsAt = new Date(reunion.startsAt);
    const endsAt = new Date(reunion.endsAt);
    if (now < startsAt) {
      return res
        .status(400)
        .json(err("Aún no puedes marcar asistencia. La reunión no ha empezado"));
    }
    const cutoff = new Date(endsAt.getTime() + 24 * 60 * 60 * 1000);
    if (now > cutoff) {
      return res
        .status(400)
        .json(
          err(
            "El plazo para marcar asistencia ha expirado (24h después de la reunión)"
          )
        );
    }

    const partRes = await pool
      .request()
      .input("rId", sql.Int, id)
      .input("uId", sql.Int, userId)
      .query(`
        SELECT
          rp.invitation_status   AS invitationStatus,
          rp.invitation_blocked_by_id AS blockedById,
          b.name                 AS blockName
        FROM core.reservation_participants rp
        LEFT JOIN auth.user_blocks b ON b.block_id = rp.invitation_blocked_by_id
        WHERE rp.reservation_id = @rId
          AND rp.user_id = @uId
          AND rp.status = 'active'
      `);
    if (partRes.recordset.length === 0) {
      return res
        .status(400)
        .json(err("Este usuario no es colaborador de la reunión"));
    }
    // Auto-justificación: si la invitación quedó pending y no asistió, y no se
    // proporcionó un motivo, el sistema escribe el nombre del bloqueo en
    // absence_reason marcado con un prefijo reconocible para distinguirlo del
    // motivo manual.
    let finalReason = cleanReason;
    const partInfo = partRes.recordset[0];
    if (
      !attended &&
      !finalReason &&
      partInfo.invitationStatus === "pending" &&
      partInfo.blockName
    ) {
      finalReason = `[Justificado automáticamente] Bloqueo personal: ${partInfo.blockName}`;
    }

    await pool
      .request()
      .input("rId", sql.Int, id)
      .input("uId", sql.Int, userId)
      .input("attended", sql.Bit, attended ? 1 : 0)
      .input("reason", sql.VarChar(LIMITS.ABSENCE_REASON), finalReason)
      .input("markedBy", sql.Int, req.user.userId)
      .query(`
        MERGE core.reservation_attendance AS target
        USING (SELECT @rId AS rId, @uId AS uId) AS source
        ON target.reservation_id = source.rId AND target.user_id = source.uId
        WHEN MATCHED THEN
          UPDATE SET attended = @attended,
                     absence_reason = @reason,
                     marked_by = @markedBy,
                     marked_at = SYSDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (reservation_id, user_id, attended, absence_reason, marked_by)
          VALUES (@rId, @uId, @attended, @reason, @markedBy);
      `);

    return res.json(ok({}, "Asistencia registrada"));
  } catch (e) {
    console.error("[reservation.setAttendance]", e);
    return res
      .status(500)
      .json(err("No fue posible registrar la asistencia"));
  }
};

// ============================================================================
//                NOTAS  (G3)
// ============================================================================

const {
  notifyNewNote,
  notifyNoteReply,
} = require("../services/notificationService");

async function fetchReservationForNote(pool, id) {
  const r = await pool
    .request()
    .input("rId", sql.Int, id)
    .query(`
      SELECT created_by AS createdBy, ends_at AS endsAt
      FROM core.reservations WHERE reservation_id = @rId
    `);
  return r.recordset[0] || null;
}

// Acceso a notas: organizador o participante activo. Admin siempre.
async function checkNoteAccess(pool, reservationId, user) {
  if (user.role === "admin") {
    const r = await pool
      .request()
      .input("rId", sql.Int, reservationId)
      .query(`
        SELECT created_by AS createdBy FROM core.reservations WHERE reservation_id = @rId
      `);
    if (r.recordset.length === 0) return null;
    return { isOrganizer: r.recordset[0].createdBy === user.userId, isParticipant: false };
  }
  const r = await pool
    .request()
    .input("rId", sql.Int, reservationId)
    .input("uId", sql.Int, user.userId)
    .query(`
      SELECT
        r.created_by AS createdBy,
        CASE WHEN p.user_id IS NOT NULL THEN 1 ELSE 0 END AS isParticipant
      FROM core.reservations r
      LEFT JOIN core.reservation_participants p
        ON p.reservation_id = r.reservation_id
       AND p.user_id = @uId
       AND p.status = 'active'
      WHERE r.reservation_id = @rId
        AND (r.created_by = @uId OR p.user_id = @uId)
    `);
  if (r.recordset.length === 0) return null;
  const row = r.recordset[0];
  return {
    isOrganizer: row.createdBy === user.userId,
    isParticipant: row.isParticipant === 1,
  };
}

const getNotes = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const access = await checkNoteAccess(pool, id, req.user);
    if (!access) return res.status(403).json(err("Sin acceso a las notas"));

    const result = await pool
      .request()
      .input("rId", sql.Int, id)
      .query(`
        SELECT
          rn.note_id        AS noteId,
          rn.parent_note_id AS parentNoteId,
          rn.content,
          rn.created_at     AS createdAt,
          rn.updated_at     AS updatedAt,
          rn.edit_count     AS editCount,
          rn.is_deleted     AS isDeleted,
          rn.deleted_by     AS deletedById,
          rn.deleted_at     AS deletedAt,
          rn.author_id      AS authorId,
          u.full_name       AS authorName,
          u.email           AS authorEmail,
          u.avatar_url      AS authorAvatarUrl
        FROM core.reservation_notes rn
        JOIN auth.users u ON u.user_id = rn.author_id
        WHERE rn.reservation_id = @rId
        ORDER BY
          CASE WHEN rn.parent_note_id IS NULL THEN rn.note_id ELSE rn.parent_note_id END DESC,
          CASE WHEN rn.parent_note_id IS NULL THEN 0 ELSE 1 END,
          rn.created_at ASC
      `);

    const rows = result.recordset.map((row) => ({
      ...row,
      isDeleted: row.isDeleted === true || row.isDeleted === 1,
      content: (row.isDeleted === true || row.isDeleted === 1)
        ? "[Nota eliminada]"
        : row.content,
      replies: [],
    }));

    const byId = new Map();
    const roots = [];
    for (const r of rows) byId.set(r.noteId, r);
    for (const r of rows) {
      if (r.parentNoteId) {
        const parent = byId.get(r.parentNoteId);
        if (parent) parent.replies.push(r);
      } else {
        roots.push(r);
      }
    }
    roots.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return res.json(ok(roots, "OK"));
  } catch (e) {
    console.error("[reservation.getNotes]", e);
    return res.status(500).json(err("No fue posible cargar las notas"));
  }
};

const createNote = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  const content =
    req.body && typeof req.body.content === "string"
      ? req.body.content.trim()
      : "";
  const parentNoteIdRaw = req.body ? req.body.parentNoteId : null;
  const parentNoteId =
    parentNoteIdRaw == null || parentNoteIdRaw === ""
      ? null
      : parseInt(parentNoteIdRaw, 10);
  if (parentNoteIdRaw != null && parentNoteIdRaw !== "" && !Number.isInteger(parentNoteId)) {
    return res.status(400).json(err("parentNoteId inválido"));
  }

  if (!content) {
    return res.status(400).json(err("La nota no puede estar vacía"));
  }
  if (content.length > LIMITS.NOTE) {
    return res
      .status(400)
      .json(err(`La nota no puede superar ${LIMITS.NOTE} caracteres`));
  }

  try {
    const pool = await getPool();
    const access = await checkNoteAccess(pool, id, req.user);
    if (!access) return res.status(403).json(err("Sin acceso a las notas"));

    let parentAuthorId = null;
    if (parentNoteId) {
      const parentCheck = await pool
        .request()
        .input("pId", sql.Int, parentNoteId)
        .input("rId", sql.Int, id)
        .query(`
          SELECT parent_note_id, author_id, is_deleted
          FROM core.reservation_notes
          WHERE note_id = @pId AND reservation_id = @rId
        `);
      if (parentCheck.recordset.length === 0) {
        return res.status(404).json(err("Nota padre no encontrada"));
      }
      const p = parentCheck.recordset[0];
      if (p.is_deleted === true || p.is_deleted === 1) {
        return res.status(400).json(err("No puedes responder a una nota eliminada"));
      }
      if (p.parent_note_id !== null) {
        return res
          .status(400)
          .json(err("No puedes responder a una respuesta. Responde a la nota raíz."));
      }
      parentAuthorId = p.author_id;
    }

    const insertRes = await pool
      .request()
      .input("rId", sql.Int, id)
      .input("parentId", sql.Int, parentNoteId)
      .input("authorId", sql.Int, req.user.userId)
      .input("content", sql.NVarChar(LIMITS.NOTE), content)
      .query(`
        INSERT INTO core.reservation_notes
          (reservation_id, parent_note_id, author_id, content,
           created_at, updated_at, edit_count, is_deleted)
        OUTPUT INSERTED.note_id AS noteId
        VALUES (@rId, @parentId, @authorId, @content, SYSDATETIME(), SYSDATETIME(), 0, 0)
      `);

    const noteId = insertRes.recordset[0].noteId;

    await logHistory({
      reservationId: id,
      actionType: parentNoteId ? "note_reply_added" : "note_added",
      actionBy: req.user.userId,
      details: { noteId, parentNoteId },
    });

    const contentPreview = content.length > 200 ? content.slice(0, 200) + "…" : content;
    try {
      if (parentNoteId) {
        await notifyNoteReply({
          reservationId: id,
          noteId,
          replyAuthorId: req.user.userId,
          parentAuthorId,
          contentPreview,
        });
      } else {
        await notifyNewNote({
          reservationId: id,
          noteId,
          authorId: req.user.userId,
          contentPreview,
        });
      }
    } catch (e) {
      console.error("[reservation.createNote.notify]", e.message);
    }

    return res.json(
      ok(
        { noteId },
        parentNoteId ? "Respuesta agregada" : "Nota agregada"
      )
    );
  } catch (e) {
    console.error("[reservation.createNote]", e);
    return res.status(500).json(err("No fue posible agregar la nota"));
  }
};

const updateNote = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const noteId = parseInt(req.params.noteId, 10);
  if (!id || !noteId)
    return res.status(400).json(err("Identificador no valido"));
  const content =
    req.body && typeof req.body.content === "string"
      ? req.body.content.trim()
      : "";
  if (!content) {
    return res.status(400).json(err("La nota no puede estar vacía"));
  }
  if (content.length > LIMITS.NOTE) {
    return res
      .status(400)
      .json(err(`La nota no puede superar ${LIMITS.NOTE} caracteres`));
  }

  try {
    const pool = await getPool();
    const noteRes = await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .input("rId", sql.Int, id)
      .query(`
        SELECT
          rn.author_id  AS authorId,
          rn.content    AS content,
          rn.edit_count AS editCount,
          rn.is_deleted AS isDeleted
        FROM core.reservation_notes rn
        WHERE rn.note_id = @noteId AND rn.reservation_id = @rId
      `);
    if (noteRes.recordset.length === 0) {
      return res.status(404).json(err("Nota no encontrada"));
    }
    const note = noteRes.recordset[0];
    if (note.isDeleted === true || note.isDeleted === 1) {
      return res.status(400).json(err("La nota fue eliminada"));
    }
    if (note.authorId !== req.user.userId) {
      return res.status(403).json(err("Solo el autor puede editar esta nota"));
    }

    if (note.content === content) {
      return res.json(ok({}, "Sin cambios"));
    }

    await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .input("prev", sql.NVarChar(sql.MAX), note.content)
      .input("editedBy", sql.Int, req.user.userId)
      .query(`
        INSERT INTO core.reservation_note_edits (note_id, previous_content, edited_by, edited_at)
        VALUES (@noteId, @prev, @editedBy, SYSDATETIME())
      `);

    await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .input("content", sql.NVarChar(LIMITS.NOTE), content)
      .query(`
        UPDATE core.reservation_notes
        SET content = @content,
            updated_at = SYSDATETIME(),
            edit_count = edit_count + 1
        WHERE note_id = @noteId
      `);

    await logHistory({
      reservationId: id,
      actionType: "note_edited",
      actionBy: req.user.userId,
      details: { noteId, editCount: (note.editCount || 0) + 1 },
    });

    return res.json(ok({}, "Nota actualizada"));
  } catch (e) {
    console.error("[reservation.updateNote]", e);
    return res.status(500).json(err("No fue posible actualizar la nota"));
  }
};

const deleteNote = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const noteId = parseInt(req.params.noteId, 10);
  if (!id || !noteId)
    return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const noteRes = await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .input("rId", sql.Int, id)
      .query(`
        SELECT
          rn.author_id  AS authorId,
          rn.is_deleted AS isDeleted,
          r.created_by  AS createdBy
        FROM core.reservation_notes rn
        JOIN core.reservations r ON r.reservation_id = rn.reservation_id
        WHERE rn.note_id = @noteId AND rn.reservation_id = @rId
      `);
    if (noteRes.recordset.length === 0) {
      return res.status(404).json(err("Nota no encontrada"));
    }
    const note = noteRes.recordset[0];
    if (note.isDeleted === true || note.isDeleted === 1) {
      return res.status(400).json(err("La nota ya fue eliminada"));
    }
    const isAuthor = note.authorId === req.user.userId;
    const isOrganizer = note.createdBy === req.user.userId;
    const isAdmin = req.user.role === "admin";
    if (!isAuthor && !isOrganizer && !isAdmin) {
      return res
        .status(403)
        .json(err("Solo el autor, organizador o admin pueden eliminar"));
    }

    await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .input("deletedBy", sql.Int, req.user.userId)
      .query(`
        UPDATE core.reservation_notes
        SET is_deleted = 1,
            deleted_by = @deletedBy,
            deleted_at = SYSDATETIME()
        WHERE note_id = @noteId
      `);

    await logHistory({
      reservationId: id,
      actionType: "note_deleted",
      actionBy: req.user.userId,
      details: {
        noteId,
        byRole: isAuthor ? "author" : isAdmin ? "admin" : "organizer",
      },
    });

    return res.json(ok({}, "Nota eliminada"));
  } catch (e) {
    console.error("[reservation.deleteNote]", e);
    return res.status(500).json(err("No fue posible eliminar la nota"));
  }
};

const getNoteEdits = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const noteId = parseInt(req.params.noteId, 10);
  if (!id || !noteId)
    return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const noteRes = await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .input("rId", sql.Int, id)
      .query(`
        SELECT
          n.note_id,
          r.created_by AS organizerId
        FROM core.reservation_notes n
        INNER JOIN core.reservations r ON r.reservation_id = n.reservation_id
        WHERE n.note_id = @noteId AND n.reservation_id = @rId
      `);
    if (noteRes.recordset.length === 0) {
      return res.status(404).json(err("Nota no encontrada"));
    }
    const { organizerId } = noteRes.recordset[0];
    const isOrganizer = organizerId === req.user.userId;
    const isAdmin = req.user.role === "admin";
    if (!isOrganizer && !isAdmin) {
      return res
        .status(403)
        .json(
          err("Solo el organizador o el administrador pueden ver el historial")
        );
    }

    const result = await pool
      .request()
      .input("noteId", sql.Int, noteId)
      .query(`
        SELECT
          e.edit_id          AS id,
          e.previous_content AS previousContent,
          e.edited_at        AS editedAt,
          e.edited_by        AS editedById,
          u.full_name        AS editedByName,
          u.email            AS editedByEmail
        FROM core.reservation_note_edits e
        JOIN auth.users u ON u.user_id = e.edited_by
        WHERE e.note_id = @noteId
        ORDER BY e.edited_at DESC
      `);

    return res.json(ok(result.recordset, "OK"));
  } catch (e) {
    console.error("[reservation.getNoteEdits]", e);
    return res.status(500).json(err("No fue posible cargar el historial"));
  }
};

// ============================================================================
//                INVITADOS EXTERNOS  (G5)
// ============================================================================

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function fetchReservationForGuest(pool, id) {
  const r = await pool
    .request()
    .input("rId", sql.Int, id)
    .query(`
      SELECT
        r.reservation_id  AS reservationId,
        r.reservation_type AS type,
        r.created_by      AS createdBy,
        r.title,
        r.starts_at       AS startsAt,
        r.ends_at         AS endsAt,
        r.meeting_link    AS meetingLink,
        r.external_address AS externalAddress,
        r.status,
        ro.name           AS roomName,
        ro.location       AS roomLocation,
        uo.full_name      AS organizerName,
        uo.email          AS organizerEmail
      FROM core.reservations r
      LEFT JOIN core.rooms ro ON ro.room_id = r.room_id
      JOIN auth.users uo      ON uo.user_id = r.created_by
      WHERE r.reservation_id = @rId
    `);
  return r.recordset[0] || null;
}

function locationLabelForGuest(reunion) {
  if (reunion.type === RESERVATION_TYPES.EXTERNAL) {
    return `Fuera de oficina${reunion.externalAddress ? ` · ${reunion.externalAddress}` : ""}`;
  }
  if (reunion.type === RESERVATION_TYPES.VIRTUAL) {
    return "Reunión virtual";
  }
  return reunion.roomLocation
    ? `${reunion.roomName} · ${reunion.roomLocation}`
    : reunion.roomName;
}

const getExternalGuests = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("rId", sql.Int, id)
      .query(`
        SELECT
          guest_id        AS guestId,
          email,
          display_name    AS displayName,
          notified,
          notified_at     AS notifiedAt,
          added_at        AS addedAt
        FROM core.reservation_external_guests
        WHERE reservation_id = @rId
        ORDER BY added_at
      `);
    const items = result.recordset.map((g) => ({
      guestId: g.guestId,
      email: g.email,
      displayName: g.displayName || null,
      notified: !!g.notified,
      notifiedAt: g.notifiedAt || null,
      addedAt: g.addedAt,
    }));
    return res.json(ok(items, "OK"));
  } catch (e) {
    console.error("[reservation.getExternalGuests]", e);
    return res
      .status(500)
      .json(err("No fue posible cargar los invitados externos"));
  }
};

const addExternalGuest = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  const { email, displayName, sendInvitation } = req.body || {};

  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail || !EMAIL_REGEX.test(cleanEmail)) {
    return res.status(400).json(err("Correo no válido"));
  }
  if (cleanEmail.length > LIMITS.GUEST_EMAIL) {
    return res.status(400).json(err("El correo es demasiado largo"));
  }
  const cleanName = displayName
    ? String(displayName).trim().slice(0, LIMITS.GUEST_DISPLAY_NAME)
    : null;
  if (cleanName && cleanName.length > LIMITS.GUEST_DISPLAY_NAME) {
    return res
      .status(400)
      .json(
        err(
          `El nombre no puede superar ${LIMITS.GUEST_DISPLAY_NAME} caracteres`
        )
      );
  }

  try {
    const pool = await getPool();
    const reunion = await fetchReservationForGuest(pool, id);
    if (!reunion) return res.status(404).json(err("Reunión no encontrada"));
    if (
      reunion.createdBy !== req.user.userId &&
      req.user.role !== "admin"
    ) {
      return res
        .status(403)
        .json(err("Solo el organizador puede agregar invitados"));
    }
    if (reunion.status !== "active") {
      return res
        .status(400)
        .json(err("No se pueden agregar invitados a una reunión cancelada"));
    }

    const dupRes = await pool
      .request()
      .input("rId", sql.Int, id)
      .input("email", sql.VarChar(LIMITS.GUEST_EMAIL), cleanEmail)
      .query(`
        SELECT 1 FROM core.reservation_external_guests
        WHERE reservation_id = @rId AND email = @email
      `);
    if (dupRes.recordset.length > 0) {
      return res
        .status(409)
        .json(err("Este correo ya está en la lista de invitados"));
    }

    const insertRes = await pool
      .request()
      .input("rId", sql.Int, id)
      .input("email", sql.VarChar(LIMITS.GUEST_EMAIL), cleanEmail)
      .input(
        "displayName",
        sql.VarChar(LIMITS.GUEST_DISPLAY_NAME),
        cleanName
      )
      .input("addedBy", sql.Int, req.user.userId)
      .query(`
        INSERT INTO core.reservation_external_guests
          (reservation_id, email, display_name, added_by)
        OUTPUT INSERTED.guest_id AS guestId
        VALUES (@rId, @email, @displayName, @addedBy)
      `);
    const guestId = insertRes.recordset[0].guestId;

    let notified = false;
    if (sendInvitation) {
      try {
        await sendGuestInvitationEmail({
          to: cleanEmail,
          guestName: cleanName || cleanEmail,
          reservationTitle: reunion.title,
          startsAt: reunion.startsAt,
          endsAt: reunion.endsAt,
          location: locationLabelForGuest(reunion),
          meetingLink: reunion.meetingLink,
          organizerName: reunion.organizerName,
          organizerEmail: reunion.organizerEmail,
        });
        await pool
          .request()
          .input("guestId", sql.Int, guestId)
          .query(`
            UPDATE core.reservation_external_guests
            SET notified = 1, notified_at = SYSDATETIME()
            WHERE guest_id = @guestId
          `);
        notified = true;
      } catch (e) {
        console.error(
          "[reservation.addExternalGuest] No se envió el correo:",
          e.message
        );
      }
    }

    return res.json(ok({ guestId, notified }, "Invitado agregado"));
  } catch (e) {
    console.error("[reservation.addExternalGuest]", e);
    return res.status(500).json(err("No fue posible agregar al invitado"));
  }
};

const removeExternalGuest = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guestId = parseInt(req.params.guestId, 10);
  if (!id || !guestId)
    return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const reunion = await fetchReservationForGuest(pool, id);
    if (!reunion) return res.status(404).json(err("Reunión no encontrada"));
    if (
      reunion.createdBy !== req.user.userId &&
      req.user.role !== "admin"
    ) {
      return res
        .status(403)
        .json(err("Solo el organizador puede quitar invitados"));
    }
    await pool
      .request()
      .input("guestId", sql.Int, guestId)
      .input("rId", sql.Int, id)
      .query(`
        DELETE FROM core.reservation_external_guests
        WHERE guest_id = @guestId AND reservation_id = @rId
      `);
    return res.json(ok({}, "Invitado eliminado"));
  } catch (e) {
    console.error("[reservation.removeExternalGuest]", e);
    return res.status(500).json(err("No fue posible eliminar al invitado"));
  }
};

// ============================================================================
//                CHECK CONFLICT (debounced desde TimeRangeInput)
// ============================================================================

const checkConflict = async (req, res) => {
  const {
    type,
    roomId,
    startsAt,
    endsAt,
    excludeReservationId,
  } = req.query || {};
  if (!startsAt || !endsAt) {
    return res.status(400).json(err("Faltan parámetros"));
  }
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return res.status(400).json(err("Fechas no válidas"));
  }
  const excludeId = excludeReservationId
    ? parseInt(excludeReservationId, 10)
    : null;
  const durationMs = end.getTime() - start.getTime();

  // Para virtual y external: chequeamos solo overlap del usuario (no de sala).
  if (type === RESERVATION_TYPES.VIRTUAL || type === RESERVATION_TYPES.EXTERNAL) {
    try {
      const overlap = await findUsersWithOverlap({
        userIds: [req.user.userId],
        startsAt: start,
        endsAt: end,
        excludeReservationId: excludeId,
      });
      if (overlap.length === 0) {
        return res.json(ok({ conflict: false }, "OK"));
      }
      return res.json(
        ok(
          {
            conflict: true,
            message: "Ya tienes otra reunión en este horario",
          },
          "OK"
        )
      );
    } catch (e) {
      console.error("[reservation.checkConflict] virtual/external", e);
      return res
        .status(500)
        .json(err("No fue posible verificar la disponibilidad"));
    }
  }

  // Tipo physical (o sin tipo explícito): chequeo contra sala física.
  if (!roomId) {
    return res.status(400).json(err("Faltan parámetros"));
  }
  const parsedRoomId = parseInt(roomId, 10);
  if (!Number.isInteger(parsedRoomId) || parsedRoomId <= 0) {
    return res.status(400).json(err("Sala no válida"));
  }

  // Cierre del día (17:00) en hora local del servidor.
  const dayClose = new Date(start);
  dayClose.setHours(17, 0, 0, 0);

  // Helper: detecta el conflicto principal en una sola query.
  const findConflict = async (pool, rangeStart, rangeEnd) => {
    const r = pool
      .request()
      .input("roomId", sql.Int, parsedRoomId)
      .input("startsAt", sql.DateTime2, rangeStart)
      .input("endsAt", sql.DateTime2, rangeEnd);
    let where = `WHERE r.room_id = @roomId
         AND r.status = 'active'
         AND r.starts_at < @endsAt
         AND (
           (r.ended_early = 1 AND r.ended_at > @startsAt)
           OR (r.ended_early = 0 AND r.ends_at > @startsAt)
         )`;
    if (excludeId) {
      where += " AND r.reservation_id <> @excludeId";
      r.input("excludeId", sql.Int, excludeId);
    }
    const result = await r.query(`
      SELECT TOP 1
        r.reservation_id, r.title, r.starts_at, r.ends_at,
        r.ended_early, r.ended_at,
        u.full_name AS creator_name
      FROM core.reservations r
      LEFT JOIN auth.users u ON u.user_id = r.created_by
      ${where}
      ORDER BY r.starts_at ASC
    `);
    return result.recordset[0] || null;
  };

  try {
    const pool = await getPool();
    const conflict = await findConflict(pool, start, end);

    if (!conflict) {
      return res.json(ok({ conflict: false }, "OK"));
    }

    // Fin efectivo de la reunión que choca (respeta ended_early).
    const conflictEnd =
      conflict.ended_early && conflict.ended_at
        ? new Date(conflict.ended_at)
        : new Date(conflict.ends_at);

    // Buscar próximo slot libre con la misma duración. Empezamos desde el fin
    // efectivo del conflicto, redondeado al próximo slot de 30 min.
    let candidateStart = new Date(conflictEnd);
    const cm = candidateStart.getMinutes();
    if (cm === 0) {
      // ya cae en slot exacto
      candidateStart.setSeconds(0, 0);
    } else if (cm <= 30) {
      candidateStart.setMinutes(30, 0, 0);
    } else {
      candidateStart.setHours(candidateStart.getHours() + 1, 0, 0, 0);
    }

    let nextFree = null;
    // Cap de iteraciones: 18 slots de 30 min cubren un día (08:00 a 17:00).
    for (let i = 0; i < 18; i++) {
      const candidateEnd = new Date(candidateStart.getTime() + durationMs);
      if (candidateEnd > dayClose) break;
      const inner = await findConflict(pool, candidateStart, candidateEnd);
      if (!inner) {
        nextFree = {
          startsAt: candidateStart.toISOString(),
          endsAt: candidateEnd.toISOString(),
        };
        break;
      }
      candidateStart = new Date(candidateStart.getTime() + 30 * 60000);
    }

    return res.json(
      ok(
        {
          conflict: true,
          message: "Hay otra reunión en este horario",
          conflictingMeeting: {
            id: conflict.reservation_id,
            title: conflict.title,
            startsAt: conflict.starts_at,
            endsAt: conflictEnd.toISOString(),
            creatorName: conflict.creator_name || null,
          },
          nextFreeSlot: nextFree,
        },
        "OK"
      )
    );
  } catch (e) {
    console.error("[reservation.checkConflict]", e);
    return res
      .status(500)
      .json(err("No fue posible verificar la disponibilidad"));
  }
};

// ============================================================================
//                BLOQUEOS PERSONALES — peticiones de invitación
// ============================================================================

// POST /api/reservations/check-blocks
// Body: { userIds: [], startsAt, endsAt }
// Devuelve los bloqueos detectados, enriquecidos con nombre del usuario.
const checkBlocks = async (req, res) => {
  const body = req.body || {};
  const userIds = Array.isArray(body.userIds) ? body.userIds : [];
  const { startsAt, endsAt } = body;
  if (!startsAt || !endsAt) {
    return res.status(400).json(err("Fechas requeridas"));
  }
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) {
    return res.status(400).json(err("Fechas no válidas"));
  }
  try {
    const blocks = await findBlocksInRange({
      userIds,
      startsAt: s,
      endsAt: e,
    });
    if (blocks.length === 0) {
      return res.json(ok([], "OK"));
    }
    const pool = await getPool();
    const uniqUserIds = [...new Set(blocks.map((b) => b.userId))];
    const placeholders = uniqUserIds.map((_, i) => `@u${i}`).join(",");
    const reqUsers = pool.request();
    uniqUserIds.forEach((id, i) => reqUsers.input(`u${i}`, sql.Int, id));
    const usersRes = await reqUsers.query(
      `SELECT user_id, full_name FROM auth.users WHERE user_id IN (${placeholders})`
    );
    const nameByUser = new Map(
      usersRes.recordset.map((u) => [u.user_id, u.full_name])
    );
    const enriched = blocks.map((b) => ({
      userId: b.userId,
      userName: nameByUser.get(b.userId) || "Usuario",
      blockId: b.blockId,
      blockName: b.blockName,
    }));
    return res.json(ok(enriched, "OK"));
  } catch (e2) {
    console.error("[reservation.checkBlocks]", e2);
    return res
      .status(500)
      .json(err("No fue posible verificar los bloqueos"));
  }
};

// POST /api/reservations/:id/invitation-response
// Body: { response: 'accept' | 'reject' }
const respondInvitation = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no válido"));
  const response = req.body && req.body.response;
  if (!["accept", "reject"].includes(response)) {
    return res.status(400).json(err("Respuesta inválida"));
  }
  try {
    const pool = await getPool();
    const check = await pool
      .request()
      .input("rId", sql.Int, id)
      .input("uId", sql.Int, req.user.userId)
      .query(`
        SELECT participant_id, invitation_status
        FROM core.reservation_participants
        WHERE reservation_id = @rId AND user_id = @uId
      `);
    if (check.recordset.length === 0) {
      return res
        .status(404)
        .json(err("No tienes invitación a esta reunión"));
    }
    if (check.recordset[0].invitation_status !== "pending") {
      return res
        .status(400)
        .json(err("Esta invitación ya fue respondida"));
    }
    const newInvStatus = response === "accept" ? "accepted" : "rejected";
    const newParticipantStatus =
      response === "reject" ? "cancelled" : "active";
    await pool
      .request()
      .input("rId", sql.Int, id)
      .input("uId", sql.Int, req.user.userId)
      .input("invStatus", sql.VarChar(20), newInvStatus)
      .input("pStatus", sql.VarChar(20), newParticipantStatus)
      .query(`
        UPDATE core.reservation_participants
        SET invitation_status = @invStatus,
            invitation_response_at = SYSDATETIME(),
            status = @pStatus
        WHERE reservation_id = @rId AND user_id = @uId
      `);

    // Historial — invitación aceptada/rechazada con bloqueo.
    logHistory({
      reservationId: id,
      actionType:
        response === "accept" ? "invitation_accepted" : "invitation_rejected",
      actionBy: req.user.userId,
      details: { response },
      pool,
    });

    // Notificar al organizador
    try {
      const meetingRes = await pool
        .request()
        .input("rId", sql.Int, id)
        .query(`
          SELECT created_by, title
          FROM core.reservations
          WHERE reservation_id = @rId
        `);
      if (meetingRes.recordset.length > 0) {
        const m = meetingRes.recordset[0];
        const verb = response === "accept" ? "aceptó" : "rechazó";
        await createNotification({
          userId: m.created_by,
          reservationId: id,
          type: "invitation_responded",
          title: `${req.user.fullName} ${verb} tu invitación`,
          body: m.title,
        });
      }
    } catch (e) {
      console.error("[respondInvitation.notify]", e.message);
    }

    return res.json(
      ok(
        { status: newInvStatus },
        response === "accept"
          ? "Aceptaste la invitación"
          : "Rechazaste la invitación"
      )
    );
  } catch (e) {
    console.error("[respondInvitation]", e);
    return res.status(500).json(err("No fue posible responder"));
  }
};

// GET /api/reservations/my-requests
const getMyRequests = async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("uId", sql.Int, req.user.userId)
      .query(`
        SELECT
          r.reservation_id    AS id,
          r.title,
          r.starts_at         AS startsAt,
          r.ends_at           AS endsAt,
          r.reservation_type  AS type,
          r.created_by        AS organizerId,
          u.full_name         AS organizerName,
          u.email             AS organizerEmail,
          u.avatar_url        AS organizerAvatarUrl,
          ro.name             AS roomName,
          b.name              AS blockName,
          p.invitation_status AS invitationStatus,
          r.meeting_link      AS meetingLink,
          r.external_address  AS externalAddress,
          r.virtual_platform  AS virtualPlatform
        FROM core.reservation_participants p
        JOIN core.reservations r ON r.reservation_id = p.reservation_id
        JOIN auth.users u        ON u.user_id        = r.created_by
        LEFT JOIN core.rooms ro  ON ro.room_id       = r.room_id
        LEFT JOIN auth.user_blocks b ON b.block_id   = p.invitation_blocked_by_id
        WHERE p.user_id = @uId
          AND p.invitation_status = 'pending'
          AND r.status = 'active'
          AND r.ends_at > SYSDATETIME()
        ORDER BY r.starts_at ASC
      `);
    return res.json(ok(result.recordset, "OK"));
  } catch (e) {
    console.error("[reservation.getMyRequests]", e);
    return res
      .status(500)
      .json(err("No fue posible obtener tus solicitudes"));
  }
};

// ============================================================================
//                TERMINAR ANTES  (G1)
// ============================================================================

const endEarly = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  const reasonRaw =
    req.body && typeof req.body.reason === "string"
      ? req.body.reason.trim()
      : "";
  if (reasonRaw && reasonRaw.length > LIMITS.END_EARLY_REASON) {
    return res
      .status(400)
      .json(
        err(`El motivo no puede superar ${LIMITS.END_EARLY_REASON} caracteres`)
      );
  }
  const reason = reasonRaw || null;

  try {
    const pool = await getPool();
    const reunRes = await pool
      .request()
      .input("rId", sql.Int, id)
      .query(`
        SELECT
          r.reservation_id, r.reservation_type, r.title, r.created_by,
          r.starts_at, r.ends_at, r.status, r.ended_early, r.meeting_link,
          r.external_address,
          ro.name AS room_name, ro.location AS room_location,
          u.full_name AS creator_name, u.email AS creator_email
        FROM core.reservations r
        LEFT JOIN core.rooms ro ON ro.room_id = r.room_id
        JOIN auth.users u       ON u.user_id  = r.created_by
        WHERE r.reservation_id = @rId
      `);
    if (reunRes.recordset.length === 0) {
      return res.status(404).json(err("Reunión no encontrada"));
    }
    const reunion = reunRes.recordset[0];
    if (
      reunion.created_by !== req.user.userId &&
      req.user.role !== "admin"
    ) {
      return res
        .status(403)
        .json(err("Solo el organizador puede terminar la reunión"));
    }
    if (reunion.status !== "active") {
      return res.status(400).json(err("La reunión no está activa"));
    }
    if (reunion.ended_early) {
      return res
        .status(400)
        .json(err("La reunión ya fue terminada antes de tiempo"));
    }
    const now = new Date();
    if (now < new Date(reunion.starts_at)) {
      return res.status(400).json(err("La reunión todavía no ha comenzado"));
    }
    if (now >= new Date(reunion.ends_at)) {
      return res.status(400).json(err("La reunión ya finalizó normalmente"));
    }

    // UPDATE crítico (devuelve 500 si falla).
    try {
      await pool
        .request()
        .input("rId", sql.Int, id)
        .input("endedBy", sql.Int, req.user.userId)
        .input("reason", sql.VarChar(LIMITS.END_EARLY_REASON), reason)
        .query(`
          UPDATE core.reservations
          SET ended_early = 1,
              ended_at = SYSDATETIME(),
              ended_by = @endedBy,
              end_early_reason = @reason
          WHERE reservation_id = @rId
        `);
    } catch (e) {
      console.error("[endEarly] UPDATE fallo:", e);
      return res
        .status(500)
        .json(err("No fue posible terminar la reunión"));
    }

    // Historial (no propaga).
    logHistory({
      reservationId: id,
      actionType: "ended_early",
      actionBy: req.user.userId,
      details: {
        originalEnd: fmtHora(reunion.ends_at),
        actualEnd: fmtHora(now),
        reason,
      },
      pool,
    });

    // Notificar a participantes activos por correo (no propaga).
    try {
      const partsRes = await pool
        .request()
        .input("rId", sql.Int, id)
        .query(`
          SELECT rp.user_id, u.email, u.full_name
          FROM core.reservation_participants rp
          JOIN auth.users u ON u.user_id = rp.user_id
          WHERE rp.reservation_id = @rId AND rp.status = 'active'
        `);
      for (const p of partsRes.recordset) {
        sendMeetingEndedEarlyEmail({
          to: p.email,
          participantName: p.full_name || p.email,
          reservationTitle: reunion.title,
          originalEndsAt: reunion.ends_at,
          endedAt: now,
          organizerName: reunion.creator_name,
          organizerEmail: reunion.creator_email,
          reason,
        }).catch((e) =>
          console.error("[endEarly.email]", e.message)
        );
      }
      if (partsRes.recordset.length > 0) {
        createNotificationsForParticipants({
          participantIds: partsRes.recordset.map((p) => p.user_id),
          reservationId: id,
          type: "ended_early",
          title: `${reunion.creator_name} terminó la reunión antes de tiempo`,
          body: reason
            ? `${reunion.title} · Motivo: "${reason}"`
            : reunion.title,
        }).catch((e) =>
          console.error("[endEarly.notify]", e.message)
        );
      }
    } catch (e) {
      console.error("[endEarly.participants]", e);
    }

    // Notificar a invitados externos con notified=1 (no propaga).
    try {
      const guestsRes = await pool
        .request()
        .input("rId", sql.Int, id)
        .query(`
          SELECT email, display_name AS displayName
          FROM core.reservation_external_guests
          WHERE reservation_id = @rId AND notified = 1
        `);
      for (const g of guestsRes.recordset) {
        sendGuestMeetingEndedEarlyEmail({
          to: g.email,
          guestName: g.displayName || g.email,
          reservationTitle: reunion.title,
          originalEndsAt: reunion.ends_at,
          endedAt: now,
          organizerName: reunion.creator_name,
          organizerEmail: reunion.creator_email,
          reason,
        }).catch((e) =>
          console.error("[endEarly.guest.email]", e.message)
        );
      }
    } catch (e) {
      console.error("[endEarly.guests]", e);
    }

    return res.json(
      ok({ id, endedAt: now.toISOString() }, "Reunión terminada")
    );
  } catch (e) {
    console.error("[endEarly]", e);
    return res.status(500).json(err("No fue posible terminar la reunión"));
  }
};

// ============================================================================
//                RESERVAR AHORA  (G2)
// ============================================================================

const createQuick = async (req, res) => {
  const { roomId, title, durationMinutes, participantIds } = req.body || {};
  if (!roomId) return res.status(400).json(err("Falta sala"));
  const cleanTitle =
    typeof title === "string" ? title.trim() : "";
  if (!cleanTitle) {
    return res.status(400).json(err("El título es obligatorio"));
  }
  if (cleanTitle.length > LIMITS.TITLE) {
    return res
      .status(400)
      .json(err(`El título no puede superar ${LIMITS.TITLE} caracteres`));
  }
  const dur = parseInt(durationMinutes, 10);
  if (!Number.isInteger(dur) || dur < 15 || dur > 240) {
    return res
      .status(400)
      .json(err("La reunión debe durar al menos 15 minutos"));
  }

  const parsedRoomId = parseInt(roomId, 10);
  if (!Number.isInteger(parsedRoomId) || parsedRoomId <= 0) {
    return res.status(400).json(err("Sala no válida"));
  }

  const cleanParticipantIds = sanitizeIds(participantIds, req.user.userId);

  const now = new Date();
  const endsAt = new Date(now.getTime() + dur * 60000);
  const closingTime = new Date(now);
  closingTime.setHours(17, 0, 0, 0);
  if (endsAt > closingTime) {
    return res
      .status(400)
      .json(err("La reunión no puede pasar las 17:00"));
  }

  let pool;
  try {
    pool = await getPool();
  } catch (e) {
    console.error("[createQuick] No pool", e);
    return res.status(500).json(err("No fue posible iniciar la reunión"));
  }

  const roomCheck = await pool
    .request()
    .input("id", sql.Int, parsedRoomId)
    .query(`SELECT is_active FROM core.rooms WHERE room_id = @id`);
  if (
    roomCheck.recordset.length === 0 ||
    !roomCheck.recordset[0].is_active
  ) {
    return res.status(400).json(err("Sala no disponible"));
  }

  const transaction = pool.transaction();
  await transaction.begin();
  let newId;
  let validParticipants = [];
  try {
    const overlapRoom = await transaction
      .request()
      .input("roomId", sql.Int, parsedRoomId)
      .input("startsAt", sql.DateTime2, now)
      .input("endsAt", sql.DateTime2, endsAt)
      .query(`
        SELECT TOP 1 reservation_id, starts_at AS startsAt
        FROM core.reservations WITH (UPDLOCK, HOLDLOCK)
        WHERE room_id = @roomId
          AND status = 'active'
          AND starts_at < @endsAt
          AND (
            (ended_early = 1 AND ended_at > @startsAt)
            OR (ended_early = 0 AND ends_at > @startsAt)
          )
      `);
    if (overlapRoom.recordset.length > 0) {
      await transaction.rollback();
      const nextRes = await pool
        .request()
        .input("roomId", sql.Int, parsedRoomId)
        .input("now", sql.DateTime2, now)
        .query(`
          SELECT TOP 1 starts_at AS startsAt
          FROM core.reservations
          WHERE room_id = @roomId
            AND status = 'active'
            AND starts_at >= @now
            AND (
              (ended_early = 1 AND ended_at > @now)
              OR (ended_early = 0 AND ends_at > @now)
            )
          ORDER BY starts_at ASC
        `);
      let availableMinutes = 0;
      if (nextRes.recordset.length > 0) {
        const nextStart = new Date(nextRes.recordset[0].startsAt);
        availableMinutes = Math.floor(
          (nextStart.getTime() - now.getTime()) / 60000
        );
      }
      return res
        .status(409)
        .json(
          err(
            availableMinutes > 0
              ? `Solo hay ${availableMinutes} minutos disponibles antes de la próxima reunión`
              : "Esta sala no está disponible ahora"
          )
        );
    }

    const allUserIds = [req.user.userId, ...cleanParticipantIds];
    const userOverlap = await findUsersWithOverlap({
      userIds: allUserIds,
      startsAt: now,
      endsAt,
      transaction,
    });
    if (userOverlap.length > 0) {
      const msg = await buildOverlapMessage(pool, userOverlap, req.user.userId);
      await transaction.rollback();
      return res.status(409).json(err(msg));
    }

    const inserted = await transaction
      .request()
      .input("roomId", sql.Int, parsedRoomId)
      .input("createdBy", sql.Int, req.user.userId)
      .input("title", sql.VarChar(LIMITS.TITLE), cleanTitle)
      .input("startsAt", sql.DateTime2, now)
      .input("endsAt", sql.DateTime2, endsAt)
      .query(`
        INSERT INTO core.reservations
          (reservation_type, room_id, created_by, title,
           starts_at, ends_at, status, external_address)
        OUTPUT inserted.reservation_id
        VALUES ('physical', @roomId, @createdBy, @title,
                @startsAt, @endsAt, 'active', NULL)
      `);
    newId = inserted.recordset[0].reservation_id;

    if (cleanParticipantIds.length > 0) {
      validParticipants = await loadActiveUsers(transaction, cleanParticipantIds);
      await insertParticipants(transaction, newId, validParticipants);
    }

    await transaction.commit();
  } catch (e) {
    try {
      await transaction.rollback();
    } catch (_) {
      /* ignore */
    }
    console.error("[createQuick]", e);
    return res
      .status(500)
      .json(err("No fue posible iniciar la reunión"));
  }

  // Historial — reserva creada vía "Reservar ahora".
  logHistory({
    reservationId: newId,
    actionType: "created",
    actionBy: req.user.userId,
    details: {
      title: cleanTitle,
      type: "physical",
      durationMinutes: dur,
      quick: true,
    },
  });

  if (validParticipants.length > 0) {
    const room = await fetchRoom(pool, parsedRoomId);
    notifyParticipants({
      reservationId: newId,
      reservationType: "physical",
      roomName: room ? room.name : "",
      roomLocation: room ? room.location : null,
      externalAddress: null,
      meetingLink: null,
      title: cleanTitle,
      description: null,
      startsAt: now,
      endsAt,
      organizerName: req.user.fullName,
      participants: validParticipants,
      action: "created",
    }).catch((e) =>
      console.error("[createQuick] Notificacion fallo:", e.message)
    );

    createNotificationsForParticipants({
      participantIds: validParticipants.map((u) => u.user_id),
      reservationId: newId,
      type: "invited",
      title: "Te invitaron a una reunión",
      body: notificationBody(cleanTitle, now),
    }).catch((e) =>
      console.error(
        "[createQuick] Notificacion interna fallo:",
        e.message
      )
    );
  }

  return res
    .status(201)
    .json(
      ok(
        { reservationId: newId, participantsNotified: validParticipants.length },
        "Reunión creada"
      )
    );
};

// ───────────────────────────── G2 — Confirmación de uso ────────────────────
// El cron `usageConfirmationJob` solicita confirmación a las reuniones físicas
// que llevan >=15 min iniciadas y nadie marcó asistencia. El organizador (o
// admin) confirma con POST /reservations/:id/confirm-usage. El frontend lee
// las pendientes desde GET /reservations/pending-confirmation.

const confirmUsage = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no válido"));

  let pool;
  try {
    pool = await getPool();
  } catch (e) {
    console.error("[confirmUsage] No pool", e);
    return res.status(500).json(err("No fue posible confirmar el uso"));
  }

  const check = await pool
    .request()
    .input("rId", sql.Int, id)
    .query(`
      SELECT reservation_id, created_by, status, usage_confirmed
      FROM core.reservations
      WHERE reservation_id = @rId
    `);

  if (check.recordset.length === 0) {
    return res.status(404).json(err("Reunión no encontrada"));
  }

  const row = check.recordset[0];
  const isAdmin = req.user.role === "admin";
  if (!isAdmin && row.created_by !== req.user.userId) {
    return res
      .status(403)
      .json(err("Solo el organizador o un administrador puede confirmar"));
  }
  if (row.status !== "active") {
    return res
      .status(400)
      .json(err("No se puede confirmar una reunión cancelada"));
  }
  if (row.usage_confirmed) {
    return res.json(ok({ id, alreadyConfirmed: true }, "Ya estaba confirmada"));
  }

  await pool
    .request()
    .input("rId", sql.Int, id)
    .query(`
      UPDATE core.reservations
      SET usage_confirmed = 1, usage_confirmed_at = SYSDATETIME()
      WHERE reservation_id = @rId
    `);

  return res.json(ok({ id }, "Uso confirmado"));
};

const getPendingConfirmation = async (req, res) => {
  let pool;
  try {
    pool = await getPool();
  } catch (e) {
    console.error("[getPendingConfirmation] No pool", e);
    return res
      .status(500)
      .json(err("No fue posible cargar las reuniones pendientes"));
  }

  const result = await pool
    .request()
    .input("uId", sql.Int, req.user.userId)
    .query(`
      SELECT
        r.reservation_id AS id,
        r.title,
        r.starts_at      AS startsAt,
        r.ends_at        AS endsAt,
        r.usage_confirmation_requested_at AS requestedAt,
        ro.name          AS roomName,
        ro.color_hex     AS roomColor
      FROM core.reservations r
      LEFT JOIN core.rooms ro ON ro.room_id = r.room_id
      WHERE r.created_by = @uId
        AND r.reservation_type = 'physical'
        AND r.status = 'active'
        AND r.usage_confirmed = 0
        AND r.usage_confirmation_requested_at IS NOT NULL
        AND r.ends_at > SYSDATETIME()
      ORDER BY r.starts_at DESC
    `);

  return res.json(ok(result.recordset, "OK"));
};

module.exports = {
  getByDateRange,
  getMine,
  getVirtual,
  getExternal,
  getWeek,
  getById,
  getParticipants,
  getHistory,
  listHistory,
  create,
  update,
  cancel,
  leaveReservation,
  getAttendance,
  setAttendance,
  getNotes,
  createNote,
  updateNote,
  deleteNote,
  getNoteEdits,
  getExternalGuests,
  addExternalGuest,
  removeExternalGuest,
  endEarly,
  createQuick,
  confirmUsage,
  getPendingConfirmation,
  checkConflict,
  checkBlocks,
  respondInvitation,
  getMyRequests,
};
