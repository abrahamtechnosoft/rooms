const { getPool, sql } = require('../config/db');
const { createNotification } = require('../utils/createNotification');
const {
  sendNewNoteEmail,
  sendNoteReplyEmail,
  sendSummaryUpdatedEmail,
} = require('./mailer');

const PREF_DEFAULTS = {
  email_new_note: true,
  email_note_reply: true,
  email_summary_change: true,
  email_participation_cancelled: true,
  email_reminders: true,
  email_blocked_invitation: true,
  email_attendance_marked: false,
};

const PREF_COLUMNS = Object.keys(PREF_DEFAULTS);

async function getPreferencesFor(userIds) {
  if (!userIds || userIds.length === 0) return new Map();
  const pool = await getPool();
  const ids = Array.from(new Set(userIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return new Map();

  const result = await pool.request().query(`
    SELECT user_id, ${PREF_COLUMNS.join(', ')}
    FROM auth.user_notification_preferences
    WHERE user_id IN (${ids.join(',')})
  `);

  const map = new Map();
  for (const row of result.recordset) {
    const prefs = {};
    for (const col of PREF_COLUMNS) {
      prefs[col] = row[col] === true || row[col] === 1;
    }
    map.set(row.user_id, prefs);
  }
  for (const id of ids) {
    if (!map.has(id)) map.set(id, { ...PREF_DEFAULTS });
  }
  return map;
}

async function fetchReservationMeta(reservationId) {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('rId', sql.Int, reservationId)
    .query(`
      SELECT
        r.reservation_id  AS id,
        r.title,
        r.starts_at       AS startsAt,
        r.ends_at         AS endsAt,
        r.created_by      AS createdBy,
        u.full_name       AS organizerName,
        u.email           AS organizerEmail
      FROM core.reservations r
      LEFT JOIN auth.users u ON u.user_id = r.created_by
      WHERE r.reservation_id = @rId
    `);
  return r.recordset[0] || null;
}

async function fetchActiveParticipants(reservationId) {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('rId', sql.Int, reservationId)
    .query(`
      SELECT u.user_id AS userId, u.email, u.full_name AS fullName
      FROM core.reservation_participants p
      JOIN auth.users u ON u.user_id = p.user_id
      WHERE p.reservation_id = @rId
        AND p.status = 'active'
        AND u.is_active = 1
    `);
  return r.recordset;
}

async function fetchUserMinimal(userId) {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('uId', sql.Int, userId)
    .query(`
      SELECT user_id AS userId, email, full_name AS fullName
      FROM auth.users WHERE user_id = @uId
    `);
  return r.recordset[0] || null;
}

// Dedup helpers that mirror the audience rules described in the prompt:
// participants + organizer, minus the author.
function buildAudience({ participants, organizerId, organizerEmail, organizerName, authorId }) {
  const seen = new Set();
  const audience = [];
  for (const p of participants) {
    if (p.userId === authorId) continue;
    if (seen.has(p.userId)) continue;
    seen.add(p.userId);
    audience.push({ userId: p.userId, email: p.email, fullName: p.fullName });
  }
  if (organizerId && organizerId !== authorId && !seen.has(organizerId)) {
    audience.push({ userId: organizerId, email: organizerEmail, fullName: organizerName });
  }
  return audience;
}

async function notifyNewNote({ reservationId, noteId, authorId, contentPreview }) {
  const meta = await fetchReservationMeta(reservationId);
  if (!meta) return;
  const author = await fetchUserMinimal(authorId);
  const authorName = author?.fullName || author?.email || 'Un colaborador';

  const participants = await fetchActiveParticipants(reservationId);
  const audience = buildAudience({
    participants,
    organizerId: meta.createdBy,
    organizerEmail: meta.organizerEmail,
    organizerName: meta.organizerName,
    authorId,
  });
  if (audience.length === 0) return;

  const prefs = await getPreferencesFor(audience.map((a) => a.userId));
  const title = `${authorName} agregó una nota`;
  const body = `En la reunión "${meta.title}"`;

  for (const u of audience) {
    await createNotification({
      userId: u.userId,
      reservationId,
      type: 'note_added',
      title,
      body,
    });
    const userPrefs = prefs.get(u.userId) || PREF_DEFAULTS;
    if (userPrefs.email_new_note && u.email) {
      try {
        await sendNewNoteEmail({
          to: u.email,
          recipientName: u.fullName || u.email,
          authorName,
          reservationTitle: meta.title,
          startsAt: meta.startsAt,
          endsAt: meta.endsAt,
          contentPreview,
        });
      } catch (e) {
        console.error('[notificationService.notifyNewNote.mail]', e.message);
      }
    }
  }
}

async function notifyNoteReply({ reservationId, noteId, replyAuthorId, parentAuthorId, contentPreview }) {
  const meta = await fetchReservationMeta(reservationId);
  if (!meta) return;
  const replier = await fetchUserMinimal(replyAuthorId);
  const replierName = replier?.fullName || replier?.email || 'Un colaborador';

  const recipients = [];
  if (parentAuthorId && parentAuthorId !== replyAuthorId) {
    const parent = await fetchUserMinimal(parentAuthorId);
    if (parent) recipients.push({ ...parent, kind: 'parent' });
  }
  if (
    meta.createdBy &&
    meta.createdBy !== replyAuthorId &&
    meta.createdBy !== parentAuthorId
  ) {
    recipients.push({
      userId: meta.createdBy,
      email: meta.organizerEmail,
      fullName: meta.organizerName,
      kind: 'organizer',
    });
  }
  if (recipients.length === 0) return;

  const prefs = await getPreferencesFor(recipients.map((r) => r.userId));
  const title = `${replierName} respondió a una nota`;
  const body = `En la reunión "${meta.title}"`;

  for (const u of recipients) {
    await createNotification({
      userId: u.userId,
      reservationId,
      type: 'note_reply',
      title,
      body,
    });
    const userPrefs = prefs.get(u.userId) || PREF_DEFAULTS;
    if (userPrefs.email_note_reply && u.email) {
      try {
        await sendNoteReplyEmail({
          to: u.email,
          recipientName: u.fullName || u.email,
          replierName,
          reservationTitle: meta.title,
          startsAt: meta.startsAt,
          endsAt: meta.endsAt,
          contentPreview,
        });
      } catch (e) {
        console.error('[notificationService.notifyNoteReply.mail]', e.message);
      }
    }
  }
}

async function notifySummaryUpdated({ reservationId, authorId, isFirst }) {
  const meta = await fetchReservationMeta(reservationId);
  if (!meta) return;
  const author = await fetchUserMinimal(authorId);
  const authorName = author?.fullName || author?.email || 'Un colaborador';

  const participants = await fetchActiveParticipants(reservationId);
  const audience = buildAudience({
    participants,
    organizerId: meta.createdBy,
    organizerEmail: meta.organizerEmail,
    organizerName: meta.organizerName,
    authorId,
  });
  if (audience.length === 0) return;

  const prefs = await getPreferencesFor(audience.map((a) => a.userId));
  const title = isFirst
    ? `${authorName} inició el resumen`
    : `${authorName} agregó un punto al resumen`;
  const body = `En la reunión "${meta.title}"`;

  for (const u of audience) {
    await createNotification({
      userId: u.userId,
      reservationId,
      type: 'summary_updated',
      title,
      body,
    });
    const userPrefs = prefs.get(u.userId) || PREF_DEFAULTS;
    if (userPrefs.email_summary_change && u.email) {
      try {
        await sendSummaryUpdatedEmail({
          to: u.email,
          recipientName: u.fullName || u.email,
          authorName,
          reservationTitle: meta.title,
          startsAt: meta.startsAt,
          endsAt: meta.endsAt,
          isFirst,
        });
      } catch (e) {
        console.error('[notificationService.notifySummaryUpdated.mail]', e.message);
      }
    }
  }
}

module.exports = {
  notifyNewNote,
  notifyNoteReply,
  notifySummaryUpdated,
  getPreferencesFor,
  PREF_DEFAULTS,
  PREF_COLUMNS,
};
