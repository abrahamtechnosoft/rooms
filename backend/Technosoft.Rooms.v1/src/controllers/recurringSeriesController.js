const { getPool, sql } = require("../config/db");
const { ok, err } = require("../utils/reply");
const { logHistory } = require("../utils/historyLogger");
const { validateUrl } = require("../utils/urlValidator");
const { generateOccurrences } = require("../utils/recurrenceGenerator");

const VALID_TYPES = ["physical", "virtual", "external"];
const VALID_PATTERNS = ["weekly", "monthly"];
const VALID_FREQUENCIES = [1, 2, 3];
const TIME_REGEX = /^([0-1]\d|2[0-3]):[0-5]\d$/;
const DAYS_REGEX = /^[1-7](,[1-7]){0,6}$/;
const MAX_INSTANCES = 500;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function parseHHMM(value) {
  const [h, m] = String(value).split(":").map((s) => parseInt(s, 10));
  return { hour: h, minute: m };
}

function sanitizeIds(ids, excludeUserId) {
  if (!Array.isArray(ids)) return [];
  const set = new Set();
  for (const raw of ids) {
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0 && n !== excludeUserId) set.add(n);
  }
  return Array.from(set);
}

async function createSeries(req, res) {
  const body = req.body || {};
  const title = String(body.title || "").trim();
  const description = body.description ? String(body.description).trim() : null;
  const reservationType = String(body.reservationType || "").trim();
  const roomId = body.roomId ? parseInt(body.roomId, 10) : null;
  const meetingLink = body.meetingLink ? String(body.meetingLink).trim() : null;
  const externalAddress = body.externalAddress
    ? String(body.externalAddress).trim()
    : null;
  const pattern = String(body.pattern || "").trim();
  const daysOfWeek = body.daysOfWeek
    ? String(body.daysOfWeek).trim()
    : null;
  const frequencyWeeks = body.frequencyWeeks
    ? parseInt(body.frequencyWeeks, 10)
    : null;
  const dayOfMonth = body.dayOfMonth ? parseInt(body.dayOfMonth, 10) : null;
  const startTime = String(body.startTime || "").trim();
  const endTime = String(body.endTime || "").trim();
  const seriesStartDateRaw = body.seriesStartDate;
  const seriesEndDateRaw = body.seriesEndDate;
  const participantIds = sanitizeIds(body.participantIds, req.user.userId);
  const departmentIds = sanitizeIds(body.departmentIds, -1);

  // Validaciones de entrada
  if (!title) return res.status(400).json(err("Título requerido"));
  if (title.length > 200) {
    return res.status(400).json(err("El título no puede superar 200 caracteres"));
  }
  if (reservationType === "office") {
    return res
      .status(400)
      .json(
        err(
          "Las reuniones de oficina no admiten recurrencia. Crea instancias individuales."
        )
      );
  }
  if (!VALID_TYPES.includes(reservationType)) {
    return res.status(400).json(err("Tipo de reunión no válido"));
  }
  if (!VALID_PATTERNS.includes(pattern)) {
    return res
      .status(400)
      .json(err("Patrón inválido. Debe ser semanal o mensual."));
  }
  if (pattern === "weekly") {
    if (!daysOfWeek || !DAYS_REGEX.test(daysOfWeek)) {
      return res.status(400).json(err("Días de la semana inválidos"));
    }
    if (!frequencyWeeks || !VALID_FREQUENCIES.includes(frequencyWeeks)) {
      return res
        .status(400)
        .json(err("Frecuencia inválida. Debe ser semanal, cada 2 o cada 3 semanas."));
    }
  }
  if (pattern === "monthly") {
    if (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) {
      return res.status(400).json(err("Día del mes inválido (1-31)"));
    }
  }
  if (!TIME_REGEX.test(startTime) || !TIME_REGEX.test(endTime)) {
    return res.status(400).json(err("Formato de hora no válido (HH:MM)"));
  }
  const { hour: sh, minute: sm } = parseHHMM(startTime);
  const { hour: eh, minute: em } = parseHHMM(endTime);
  if (eh * 60 + em <= sh * 60 + sm) {
    return res
      .status(400)
      .json(err("La hora de fin debe ser posterior a la de inicio"));
  }

  const startDate = new Date(seriesStartDateRaw);
  const endDate = new Date(seriesEndDateRaw);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return res.status(400).json(err("Fechas no válidas"));
  }
  if (endDate < startDate) {
    return res
      .status(400)
      .json(err("La fecha de fin debe ser posterior al inicio"));
  }
  if (endDate.getTime() - startDate.getTime() > ONE_YEAR_MS) {
    return res.status(400).json(err("La serie no puede durar más de 1 año"));
  }

  if (reservationType === "physical" && !roomId) {
    return res.status(400).json(err("Sala requerida para reuniones físicas"));
  }
  if (reservationType === "virtual" && meetingLink) {
    const check = validateUrl(meetingLink, "enlace de reunión");
    if (!check.valid) return res.status(400).json(err(check.error));
  }
  if (reservationType === "external" && !externalAddress) {
    return res.status(400).json(err("La dirección es obligatoria para reuniones externas"));
  }

  // Generar ocurrencias
  const startTimeDate = new Date(2000, 0, 1, sh, sm, 0, 0);
  const endTimeDate = new Date(2000, 0, 1, eh, em, 0, 0);
  let occurrences;
  try {
    occurrences = generateOccurrences({
      pattern,
      daysOfWeek:
        pattern === "weekly" && daysOfWeek ? daysOfWeek.split(",") : null,
      frequencyWeeks: pattern === "weekly" ? frequencyWeeks : null,
      dayOfMonth: pattern === "monthly" ? dayOfMonth : null,
      startDate,
      endDate,
      startTime: startTimeDate,
      endTime: endTimeDate,
    });
  } catch (e) {
    return res.status(400).json(err(e.message));
  }

  if (occurrences.length === 0) {
    return res
      .status(400)
      .json(err("No se generaron ocurrencias con los parámetros indicados"));
  }
  if (occurrences.length > MAX_INSTANCES) {
    return res
      .status(400)
      .json(
        err(
          `Demasiadas instancias (${occurrences.length}). Reduce el rango o cambia el patrón.`
        )
      );
  }

  const pool = await getPool();
  const transaction = pool.transaction();

  try {
    await transaction.begin();

    // 1. Insertar la serie
    const seriesRes = await transaction
      .request()
      .input("title", sql.NVarChar(200), title)
      .input("description", sql.NVarChar(sql.MAX), description)
      .input("type", sql.VarChar(20), reservationType)
      .input("roomId", sql.Int, roomId)
      .input("meetingLink", sql.NVarChar(1000), meetingLink)
      .input("externalAddress", sql.NVarChar(500), externalAddress)
      .input("pattern", sql.VarChar(20), pattern)
      .input(
        "daysOfWeek",
        sql.VarChar(30),
        pattern === "weekly" ? daysOfWeek : null
      )
      .input(
        "frequencyWeeks",
        sql.Int,
        pattern === "weekly" ? frequencyWeeks : null
      )
      .input("dayOfMonth", sql.Int, pattern === "monthly" ? dayOfMonth : null)
      .input("startTime", sql.VarChar(8), startTime + ":00")
      .input("endTime", sql.VarChar(8), endTime + ":00")
      .input("seriesStartDate", sql.Date, startDate)
      .input("seriesEndDate", sql.Date, endDate)
      .input("createdBy", sql.Int, req.user.userId)
      .query(`
        INSERT INTO core.recurring_series (
          title, description, reservation_type, room_id, meeting_link, external_address,
          pattern, days_of_week, frequency_weeks, day_of_month, start_time, end_time,
          series_start_date, series_end_date, created_by
        )
        OUTPUT INSERTED.series_id
        VALUES (
          @title, @description, @type, @roomId, @meetingLink, @externalAddress,
          @pattern, @daysOfWeek, @frequencyWeeks, @dayOfMonth, @startTime, @endTime,
          @seriesStartDate, @seriesEndDate, @createdBy
        )
      `);

    const seriesId = seriesRes.recordset[0].series_id;

    // 2. Participantes individuales de la serie
    for (const userId of participantIds) {
      await transaction
        .request()
        .input("sId", sql.Int, seriesId)
        .input("uId", sql.Int, userId)
        .query(`
          INSERT INTO core.recurring_series_participants (series_id, user_id)
          VALUES (@sId, @uId)
        `);
    }

    // 3. Departamentos de la serie
    for (const deptId of departmentIds) {
      await transaction
        .request()
        .input("sId", sql.Int, seriesId)
        .input("dId", sql.Int, deptId)
        .query(`
          INSERT INTO core.recurring_series_departments (series_id, department_id)
          VALUES (@sId, @dId)
        `);
    }

    // 4. Resolver miembros de departamentos (snapshot al crear la serie)
    let deptMemberIds = [];
    if (departmentIds.length > 0) {
      const placeholders = departmentIds
        .map((_, i) => `@d${i}`)
        .join(",");
      const deptReq = transaction.request();
      departmentIds.forEach((d, i) => deptReq.input(`d${i}`, sql.Int, d));
      const deptRes = await deptReq.query(`
        SELECT DISTINCT user_id
        FROM auth.users
        WHERE is_active = 1
          AND department_id IN (${placeholders})
      `);
      deptMemberIds = deptRes.recordset
        .map((r) => r.user_id)
        .filter((uid) => uid !== req.user.userId);
    }

    const allParticipantIds = Array.from(
      new Set([...participantIds, ...deptMemberIds])
    );

    // 5. Generar instancias
    const generatedReservationIds = [];
    let skippedCount = 0;

    for (const occ of occurrences) {
      // Si es físico, saltar instancias con conflicto de sala
      if (reservationType === "physical") {
        const conflictRes = await transaction
          .request()
          .input("roomId", sql.Int, roomId)
          .input("start", sql.DateTime2, occ.startsAt)
          .input("end", sql.DateTime2, occ.endsAt)
          .query(`
            SELECT TOP 1 reservation_id
            FROM core.reservations WITH (UPDLOCK, HOLDLOCK)
            WHERE room_id = @roomId
              AND status = 'active'
              AND starts_at < @end
              AND ends_at > @start
          `);
        if (conflictRes.recordset.length > 0) {
          skippedCount++;
          continue;
        }
      }

      const insertRes = await transaction
        .request()
        .input("title", sql.NVarChar(200), title)
        .input("description", sql.NVarChar(sql.MAX), description)
        .input("type", sql.VarChar(20), reservationType)
        .input("roomId", sql.Int, roomId)
        .input("meetingLink", sql.NVarChar(1000), meetingLink)
        .input("externalAddress", sql.NVarChar(500), externalAddress)
        .input("start", sql.DateTime2, occ.startsAt)
        .input("end", sql.DateTime2, occ.endsAt)
        .input("createdBy", sql.Int, req.user.userId)
        .input("seriesId", sql.Int, seriesId)
        .query(`
          INSERT INTO core.reservations (
            title, description, reservation_type, room_id, meeting_link, external_address,
            starts_at, ends_at, created_by, status, recurring_series_id, is_exception
          )
          OUTPUT INSERTED.reservation_id
          VALUES (
            @title, @description, @type, @roomId, @meetingLink, @externalAddress,
            @start, @end, @createdBy, 'active', @seriesId, 0
          )
        `);

      const reservationId = insertRes.recordset[0].reservation_id;
      generatedReservationIds.push(reservationId);

      // Replicar participantes en cada instancia (auto_accepted, sin bloqueos)
      for (const uid of allParticipantIds) {
        await transaction
          .request()
          .input("rId", sql.Int, reservationId)
          .input("uId", sql.Int, uid)
          .query(`
            INSERT INTO core.reservation_participants
              (reservation_id, user_id, status, invitation_status)
            VALUES (@rId, @uId, 'active', 'auto_accepted')
          `);
      }
    }

    await transaction.commit();

    if (generatedReservationIds.length > 0) {
      await logHistory({
        reservationId: generatedReservationIds[0],
        actionType: "recurring_series_created",
        actionBy: req.user.userId,
        details: {
          seriesId,
          pattern,
          instancesGenerated: generatedReservationIds.length,
          skipped: skippedCount,
        },
      });
    }

    return res.json(
      ok(
        {
          seriesId,
          instancesGenerated: generatedReservationIds.length,
          skipped: skippedCount,
        },
        `Serie creada con ${generatedReservationIds.length} ${
          generatedReservationIds.length === 1 ? "instancia" : "instancias"
        }${skippedCount > 0 ? ` (${skippedCount} omitidas por conflicto)` : ""}`
      )
    );
  } catch (e) {
    try {
      await transaction.rollback();
    } catch (_) {
      /* ignore */
    }
    console.error("[recurringSeries.create]", e);
    return res.status(500).json(err("No fue posible crear la serie"));
  }
}

async function getSeries(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const seriesRes = await pool
      .request()
      .input("sId", sql.Int, id)
      .query(`
        SELECT
          s.series_id        AS id,
          s.title,
          s.description,
          s.reservation_type AS reservationType,
          s.room_id          AS roomId,
          r.name             AS roomName,
          s.meeting_link     AS meetingLink,
          s.external_address AS externalAddress,
          s.pattern,
          s.days_of_week     AS daysOfWeek,
          s.frequency_weeks  AS frequencyWeeks,
          s.day_of_month     AS dayOfMonth,
          CONVERT(VARCHAR(5), s.start_time, 108) AS startTime,
          CONVERT(VARCHAR(5), s.end_time, 108)   AS endTime,
          s.series_start_date AS seriesStartDate,
          s.series_end_date   AS seriesEndDate,
          s.created_by        AS createdBy,
          u.full_name         AS createdByName,
          s.is_active         AS isActive,
          s.created_at        AS createdAt
        FROM core.recurring_series s
        LEFT JOIN core.rooms r ON r.room_id = s.room_id
        JOIN auth.users u ON u.user_id = s.created_by
        WHERE s.series_id = @sId
      `);
    if (seriesRes.recordset.length === 0) {
      return res.status(404).json(err("Serie no encontrada"));
    }

    const series = seriesRes.recordset[0];
    series.isActive = series.isActive === true || series.isActive === 1;

    const statsRes = await pool
      .request()
      .input("sId", sql.Int, id)
      .query(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'active' AND ends_at > SYSDATETIME() THEN 1 ELSE 0 END) AS upcoming,
          SUM(CASE WHEN status = 'active' AND ends_at <= SYSDATETIME() THEN 1 ELSE 0 END) AS past,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
          SUM(CASE WHEN is_exception = 1 THEN 1 ELSE 0 END) AS exceptions
        FROM core.reservations
        WHERE recurring_series_id = @sId
      `);

    return res.json(ok({ ...series, stats: statsRes.recordset[0] }, "OK"));
  } catch (e) {
    console.error("[recurringSeries.get]", e);
    return res.status(500).json(err("No fue posible cargar la serie"));
  }
}

async function listInstances(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("sId", sql.Int, id)
      .query(`
        SELECT
          reservation_id AS id,
          title,
          starts_at     AS startsAt,
          ends_at       AS endsAt,
          status,
          is_exception  AS isException
        FROM core.reservations
        WHERE recurring_series_id = @sId
        ORDER BY starts_at ASC
      `);
    const items = result.recordset.map((r) => ({
      ...r,
      isException: r.isException === true || r.isException === 1,
    }));
    return res.json(ok(items, "OK"));
  } catch (e) {
    console.error("[recurringSeries.listInstances]", e);
    return res.status(500).json(err("No fue posible cargar las instancias"));
  }
}

async function editSeriesFromInstance(req, res) {
  const id = parseInt(req.params.id, 10);
  const reservationId = parseInt(req.params.reservationId, 10);
  if (!id || !reservationId) {
    return res.status(400).json(err("Identificador no valido"));
  }

  const body = req.body || {};
  const hasTitle = Object.prototype.hasOwnProperty.call(body, "title");
  const hasDescription = Object.prototype.hasOwnProperty.call(body, "description");
  const hasMeetingLink = Object.prototype.hasOwnProperty.call(body, "meetingLink");
  const hasExternalAddress = Object.prototype.hasOwnProperty.call(body, "externalAddress");

  if (!hasTitle && !hasDescription && !hasMeetingLink && !hasExternalAddress) {
    return res.status(400).json(err("No hay cambios para guardar"));
  }

  const newTitle = hasTitle ? String(body.title || "").trim() : null;
  if (hasTitle && (newTitle.length === 0 || newTitle.length > 200)) {
    return res.status(400).json(err("Título no válido (1-200 caracteres)"));
  }

  const newDescription = hasDescription
    ? body.description == null
      ? null
      : String(body.description).trim()
    : null;

  const newMeetingLink = hasMeetingLink
    ? body.meetingLink == null
      ? null
      : String(body.meetingLink).trim()
    : null;
  if (hasMeetingLink && newMeetingLink) {
    const check = validateUrl(newMeetingLink, "enlace de reunión");
    if (!check.valid) return res.status(400).json(err(check.error));
  }

  const newExternalAddress = hasExternalAddress
    ? body.externalAddress == null
      ? null
      : String(body.externalAddress).trim()
    : null;

  try {
    const pool = await getPool();
    const seriesCheck = await pool
      .request()
      .input("sId", sql.Int, id)
      .query(`
        SELECT created_by, is_active
        FROM core.recurring_series
        WHERE series_id = @sId
      `);
    if (seriesCheck.recordset.length === 0) {
      return res.status(404).json(err("Serie no encontrada"));
    }
    const series = seriesCheck.recordset[0];
    if (!(series.is_active === true || series.is_active === 1)) {
      return res.status(400).json(err("La serie ya fue cancelada"));
    }
    if (series.created_by !== req.user.userId && req.user.role !== "admin") {
      return res
        .status(403)
        .json(err("Solo el creador o un administrador puede editar la serie"));
    }

    const instanceRes = await pool
      .request()
      .input("rId", sql.Int, reservationId)
      .input("sId", sql.Int, id)
      .query(`
        SELECT starts_at
        FROM core.reservations
        WHERE reservation_id = @rId AND recurring_series_id = @sId
      `);
    if (instanceRes.recordset.length === 0) {
      return res.status(404).json(err("Instancia no encontrada en esta serie"));
    }
    const fromDate = instanceRes.recordset[0].starts_at;

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      // 1. Actualizar la serie (para futuras consultas/regeneraciones)
      const seriesSets = [];
      const seriesReq = transaction.request().input("sId", sql.Int, id);
      if (hasTitle) {
        seriesSets.push("title = @title");
        seriesReq.input("title", sql.NVarChar(200), newTitle);
      }
      if (hasDescription) {
        seriesSets.push("description = @description");
        seriesReq.input(
          "description",
          sql.NVarChar(sql.MAX),
          newDescription || null
        );
      }
      if (hasMeetingLink) {
        seriesSets.push("meeting_link = @meetingLink");
        seriesReq.input(
          "meetingLink",
          sql.NVarChar(1000),
          newMeetingLink || null
        );
      }
      if (hasExternalAddress) {
        seriesSets.push("external_address = @externalAddress");
        seriesReq.input(
          "externalAddress",
          sql.NVarChar(500),
          newExternalAddress || null
        );
      }
      if (seriesSets.length > 0) {
        await seriesReq.query(`
          UPDATE core.recurring_series
          SET ${seriesSets.join(", ")}
          WHERE series_id = @sId
        `);
      }

      // 2. Actualizar instancias futuras (desde fromDate inclusive) que no
      //    sean excepciones y estén activas.
      const instSets = [];
      const instReq = transaction
        .request()
        .input("sId", sql.Int, id)
        .input("fromDate", sql.DateTime2, fromDate);
      if (hasTitle) {
        instSets.push("title = @title");
        instReq.input("title", sql.NVarChar(200), newTitle);
      }
      if (hasDescription) {
        instSets.push("description = @description");
        instReq.input(
          "description",
          sql.NVarChar(sql.MAX),
          newDescription || null
        );
      }
      if (hasMeetingLink) {
        instSets.push("meeting_link = @meetingLink");
        instReq.input(
          "meetingLink",
          sql.NVarChar(1000),
          newMeetingLink || null
        );
      }
      if (hasExternalAddress) {
        instSets.push("external_address = @externalAddress");
        instReq.input(
          "externalAddress",
          sql.NVarChar(500),
          newExternalAddress || null
        );
      }

      let affected = 0;
      if (instSets.length > 0) {
        const r = await instReq.query(`
          UPDATE core.reservations
          SET ${instSets.join(", ")}
          WHERE recurring_series_id = @sId
            AND starts_at >= @fromDate
            AND is_exception = 0
            AND status = 'active'
        `);
        affected = r.rowsAffected[0] || 0;
      }

      await transaction.commit();

      await logHistory({
        reservationId,
        actionType: "recurring_series_edited",
        actionBy: req.user.userId,
        details: {
          seriesId: id,
          fieldsChanged: [
            hasTitle && "title",
            hasDescription && "description",
            hasMeetingLink && "meetingLink",
            hasExternalAddress && "externalAddress",
          ].filter(Boolean),
          instancesUpdated: affected,
        },
      });

      return res.json(
        ok({ instancesUpdated: affected }, "Serie actualizada desde esta instancia")
      );
    } catch (e) {
      try {
        await transaction.rollback();
      } catch (_) {
        /* ignore */
      }
      console.error("[recurringSeries.editFromInstance]", e);
      return res.status(500).json(err("No fue posible actualizar la serie"));
    }
  } catch (e) {
    console.error("[recurringSeries.editFromInstance.outer]", e);
    return res.status(500).json(err("No fue posible actualizar la serie"));
  }
}

async function cancelSeries(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));
  const reasonRaw = (req.body && req.body.reason) || "";
  const reason = String(reasonRaw).trim().slice(0, 500);

  try {
    const pool = await getPool();
    const check = await pool
      .request()
      .input("sId", sql.Int, id)
      .query(`
        SELECT created_by, is_active
        FROM core.recurring_series
        WHERE series_id = @sId
      `);
    if (check.recordset.length === 0) {
      return res.status(404).json(err("Serie no encontrada"));
    }
    const series = check.recordset[0];
    if (!(series.is_active === true || series.is_active === 1)) {
      return res.status(400).json(err("La serie ya fue cancelada"));
    }
    if (series.created_by !== req.user.userId && req.user.role !== "admin") {
      return res
        .status(403)
        .json(err("Solo el creador o un administrador puede cancelar la serie"));
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction
        .request()
        .input("sId", sql.Int, id)
        .query(`
          UPDATE core.recurring_series
          SET is_active = 0
          WHERE series_id = @sId
        `);

      const cancelRes = await transaction
        .request()
        .input("sId", sql.Int, id)
        .input("reason", sql.VarChar(500), reason || "Serie cancelada")
        .input("userId", sql.Int, req.user.userId)
        .query(`
          UPDATE core.reservations
          SET status = 'cancelled',
              cancel_reason = @reason,
              cancelled_by = @userId,
              cancelled_at = SYSDATETIME()
          WHERE recurring_series_id = @sId
            AND status = 'active'
            AND ends_at > SYSDATETIME()
        `);

      await transaction.commit();

      const instancesCancelled = cancelRes.rowsAffected[0] || 0;

      await logHistory({
        reservationId: null,
        actionType: "recurring_series_cancelled",
        actionBy: req.user.userId,
        details: { seriesId: id, instancesCancelled, reason },
      });

      return res.json(
        ok(
          { instancesCancelled },
          `Serie cancelada (${instancesCancelled} ${
            instancesCancelled === 1 ? "instancia futura" : "instancias futuras"
          })`
        )
      );
    } catch (e) {
      try {
        await transaction.rollback();
      } catch (_) {
        /* ignore */
      }
      console.error("[recurringSeries.cancel]", e);
      return res.status(500).json(err("No fue posible cancelar la serie"));
    }
  } catch (e) {
    console.error("[recurringSeries.cancel.outer]", e);
    return res.status(500).json(err("No fue posible cancelar la serie"));
  }
}

async function deleteSeries(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json(err("Identificador no valido"));

  try {
    const pool = await getPool();
    const check = await pool
      .request()
      .input("sId", sql.Int, id)
      .query(`
        SELECT created_by, is_active
        FROM core.recurring_series
        WHERE series_id = @sId
      `);
    if (check.recordset.length === 0) {
      return res.status(404).json(err("Serie no encontrada"));
    }
    const series = check.recordset[0];
    if (series.created_by !== req.user.userId && req.user.role !== "admin") {
      return res
        .status(403)
        .json(err("Solo el creador o un administrador puede eliminar la serie"));
    }

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      const futureDel = await transaction
        .request()
        .input("sId", sql.Int, id)
        .query(`
          DELETE FROM core.reservations
          WHERE recurring_series_id = @sId
            AND starts_at >= SYSDATETIME()
        `);

      await transaction
        .request()
        .input("sId", sql.Int, id)
        .query(`
          UPDATE core.recurring_series
          SET is_active = 0
          WHERE series_id = @sId
        `);

      await transaction.commit();

      const deletedInstances = futureDel.rowsAffected[0] || 0;

      await logHistory({
        reservationId: null,
        actionType: "recurring_series_deleted",
        actionBy: req.user.userId,
        details: { seriesId: id, deletedInstances },
      });

      return res.json(
        ok(
          { seriesId: id, deletedInstances },
          deletedInstances > 0
            ? `Serie eliminada (${deletedInstances} ${
                deletedInstances === 1
                  ? "instancia futura"
                  : "instancias futuras"
              })`
            : "Serie eliminada"
        )
      );
    } catch (e) {
      try {
        await transaction.rollback();
      } catch (_) {
        /* ignore */
      }
      console.error("[recurringSeries.delete]", e);
      return res.status(500).json(err("No fue posible eliminar la serie"));
    }
  } catch (e) {
    console.error("[recurringSeries.delete.outer]", e);
    return res.status(500).json(err("No fue posible eliminar la serie"));
  }
}

module.exports = {
  createSeries,
  getSeries,
  listInstances,
  editSeriesFromInstance,
  cancelSeries,
  deleteSeries,
};
