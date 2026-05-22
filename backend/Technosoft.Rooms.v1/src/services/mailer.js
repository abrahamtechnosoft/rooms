const sgMail = require('@sendgrid/mail');
const { getPool, sql } = require('../config/db');

const apiKey = process.env.SENDGRID_API_KEY;
if (apiKey) {
  sgMail.setApiKey(apiKey);
}

async function sendLoginCode(toEmail, fullName, code) {
  if (!apiKey) {
    console.log('================================');
    console.log(`[mailer dev] Codigo de login para ${toEmail}: ${code}`);
    console.log('================================');
    return { ok: true, dev: true };
  }

  const html = buildLoginCodeHtml(fullName, code);
  const text =
    `Hola ${fullName},\n\n` +
    `Tu codigo de acceso a Rooms es: ${code}\n\n` +
    `Vence en 10 minutos.\n\n` +
    `Corporacion Millenium`;

  const msg = {
    to: toEmail,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME,
    },
    subject: 'Tu codigo de acceso a Rooms',
    text,
    html,
  };

  try {
    await sgMail.send(msg);
    console.log(`[mailer] Codigo enviado a ${toEmail}`);
    return { ok: true, dev: false };
  } catch (e) {
    console.error('[mailer] Fallo SendGrid:');
    console.error('  status:', e.code || (e.response && e.response.statusCode));
    console.error('  body:', JSON.stringify(e.response && e.response.body, null, 2));
    console.error('  from:', process.env.SENDGRID_FROM_EMAIL);
    console.error('  to:', toEmail);
    throw e;
  }
}

function buildLoginCodeHtml(fullName, code) {
  return `
  <!doctype html>
  <html>
    <body style="margin:0;padding:0;background:#F5F5F5;font-family:Inter,Arial,sans-serif;color:#1A1A1A;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;padding:32px 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;padding:32px;">
              <tr>
                <td style="text-align:center;padding-bottom:16px;">
                  <h1 style="margin:0;color:#2C3E50;font-size:20px;">Corporación Millenium</h1>
                  <p style="margin:4px 0 0 0;color:#7F8C8D;font-size:13px;">Plataforma de reuniones</p>
                </td>
              </tr>
              <tr>
                <td style="padding:24px 0;">
                  <p style="margin:0 0 16px 0;font-size:15px;">Hola ${fullName},</p>
                  <p style="margin:0 0 16px 0;font-size:15px;">Tu código de acceso es:</p>
                  <div style="background:#F5F5F5;border-radius:12px;padding:24px;text-align:center;">
                    <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#2C3E50;">${code}</span>
                  </div>
                  <p style="margin:16px 0 0 0;font-size:13px;color:#7F8C8D;">Este código vence en 10 minutos. Si no solicitaste este acceso, ignora este mensaje.</p>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #eee;padding-top:16px;text-align:center;">
                  <p style="margin:0;font-size:12px;color:#7F8C8D;">Corporación Millenium &copy; 2026</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>`;
}

// ============================================================================
//                NOTIFICACION DE COLABORADORES EN RESERVAS
// ============================================================================

function formatFechaEs(d) {
  const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const meses = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  return `${dias[d.getDay()]} ${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

function fmtHora(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function describeChangeHtml(c) {
  switch (c.type) {
    case 'rescheduled':
      return `<strong>Horario:</strong> ${escapeHtml(c.old || '')} → ${escapeHtml(c.new || '')}`;
    case 'room_changed':
      return `<strong>Sala:</strong> ${escapeHtml(c.old || '')} → ${escapeHtml(c.new || '')}`;
    case 'title_changed':
      return `<strong>Título:</strong> &ldquo;${escapeHtml(c.old || '')}&rdquo; → &ldquo;${escapeHtml(c.new || '')}&rdquo;`;
    case 'link_changed':
      return `<strong>Enlace de reunión:</strong> ${c.new ? 'actualizado' : 'eliminado'}`;
    case 'modality_changed':
      return `<strong>Modalidad:</strong> ${escapeHtml(c.old || '')} → ${escapeHtml(c.new || '')}`;
    default:
      return '';
  }
}

function describeChangeText(c) {
  switch (c.type) {
    case 'rescheduled':
      return `  Horario:    ${c.old || ''} -> ${c.new || ''}`;
    case 'room_changed':
      return `  Sala:       ${c.old || ''} -> ${c.new || ''}`;
    case 'title_changed':
      return `  Título:     "${c.old || ''}" -> "${c.new || ''}"`;
    case 'link_changed':
      return `  Enlace:     ${c.new ? 'actualizado' : 'eliminado'}`;
    case 'modality_changed':
      return `  Modalidad:  ${c.old || ''} -> ${c.new || ''}`;
    default:
      return '';
  }
}

function buildInvitationHtml({
  participantName, organizerName, action,
  title, description, roomName, roomLocation,
  reservationType, externalAddress, meetingLink,
  fechaLabel, horaLabel,
  changes = [],
  cancelReason = '',
  cancelledInProgress = false,
}) {
  const isVirtualType = reservationType === 'virtual';
  const isExternalType = reservationType === 'external';
  const accent =
    action === 'cancelled'   ? '#C0392B' :
    action === 'rescheduled' ? '#E67E22' :
    action === 'updated'     ? '#2C3E50' : '#27AE60';

  const intro =
    action === 'cancelled' && cancelledInProgress
      ? `<strong style="color:#C0392B;">⚠ Una reunión que estaba en curso fue cancelada por el organizador:</strong>` :
    action === 'cancelled'   ? `La siguiente reunión ha sido <strong>cancelada</strong>:` :
    action === 'rescheduled' ? `Una reunión donde estás invitado ha sido <strong>reagendada</strong>:` :
    action === 'updated'     ? `Hay cambios en una reunión donde estás invitado:` :
                               `Has sido invitado a una reunión:`;

  const changesBlock = action === 'rescheduled' && changes.length > 0
    ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF3E0;border-left:3px solid ${accent};border-radius:8px;padding:12px;margin-bottom:16px;">
        <tr><td style="font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:8px;">Cambios</td></tr>
        ${changes
          .map(
            (c) => `<tr><td style="font-size:14px;padding:4px 0;line-height:1.4;">${describeChangeHtml(c)}</td></tr>`
          )
          .join('')}
      </table>
    `
    : '';

  const motivoBlock = action === 'cancelled' && cancelReason
    ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FEE2E2;border-left:3px solid #C0392B;border-radius:8px;padding:12px;margin-bottom:16px;">
        <tr><td style="font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:8px;">Motivo de la cancelación</td></tr>
        <tr><td style="font-size:14px;color:#1F2937;line-height:1.5;">${escapeHtml(cancelReason)}</td></tr>
      </table>
    `
    : '';

  return `
  <!doctype html>
  <html>
    <body style="margin:0;padding:0;background:#F5F5F5;font-family:Inter,Arial,sans-serif;color:#1A1A1A;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;padding:32px 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;">
              <tr>
                <td style="background:${accent};padding:24px 32px;color:#ffffff;">
                  <p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Corporación Millenium · Rooms</p>
                  <h1 style="margin:8px 0 0 0;font-size:22px;font-weight:600;">${escapeHtml(title)}</h1>
                </td>
              </tr>
              <tr>
                <td style="padding:28px 32px;">
                  <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(participantName)},</p>
                  <p style="margin:0 0 20px 0;font-size:15px;">${intro}</p>

                  ${changesBlock}
                  ${motivoBlock}

                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
                    <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Organizado por</td></tr>
                    <tr><td style="padding:0 0 12px 0;font-size:15px;font-weight:500;">${escapeHtml(organizerName)}</td></tr>

                    ${isVirtualType ? `
                    <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Modalidad</td></tr>
                    <tr><td style="padding:0 0 12px 0;font-size:15px;">🖥️ Virtual</td></tr>
                    ${meetingLink ? `
                    <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Enlace de reunión</td></tr>
                    <tr><td style="padding:0 0 12px 0;font-size:15px;"><a href="${escapeHtml(meetingLink)}" style="color:#2C3E50;text-decoration:underline;word-break:break-all;">${escapeHtml(meetingLink)}</a></td></tr>
                    ` : ''}
                    ` : isExternalType ? `
                    <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Modalidad</td></tr>
                    <tr><td style="padding:0 0 12px 0;font-size:15px;">📍 Fuera de oficina${externalAddress ? ' · ' + escapeHtml(externalAddress) : ''}</td></tr>
                    ` : `
                    <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Sala</td></tr>
                    <tr><td style="padding:0 0 12px 0;font-size:15px;">${escapeHtml(roomName || '')}${roomLocation ? ' · ' + escapeHtml(roomLocation) : ''}</td></tr>
                    `}

                    <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Fecha</td></tr>
                    <tr><td style="padding:0 0 12px 0;font-size:15px;">${escapeHtml(fechaLabel)}</td></tr>

                    <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Horario</td></tr>
                    <tr><td style="padding:0;font-size:15px;font-weight:500;">${escapeHtml(horaLabel)}</td></tr>
                  </table>

                  ${description ? `
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-left:3px solid ${accent};padding-left:14px;margin-bottom:16px;">
                    <tr><td style="font-size:13px;color:#7F8C8D;padding-bottom:4px;">Descripción</td></tr>
                    <tr><td style="font-size:14px;line-height:1.5;">${escapeHtml(description)}</td></tr>
                  </table>
                  ` : ''}

                  <p style="margin:24px 0 0 0;font-size:13px;color:#7F8C8D;">Si tienes preguntas sobre esta reunión, contacta directamente a ${escapeHtml(organizerName)}.</p>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #eee;padding:16px;text-align:center;font-size:12px;color:#7F8C8D;">
                  Corporación Millenium &copy; ${new Date().getFullYear()}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>`;
}

function buildInvitationText({
  participantName, organizerName, action,
  title, description, roomName, roomLocation,
  reservationType, externalAddress, meetingLink,
  fechaLabel, horaLabel,
  changes = [],
  cancelReason = '',
  cancelledInProgress = false,
}) {
  const isVirtualType = reservationType === 'virtual';
  const isExternalType = reservationType === 'external';
  const intro =
    action === 'cancelled' && cancelledInProgress
      ? `[!] Una reunión que estaba en curso fue cancelada por el organizador:` :
    action === 'cancelled'   ? `La siguiente reunión ha sido cancelada:` :
    action === 'rescheduled' ? `Una reunión donde estás invitado ha sido reagendada:` :
    action === 'updated'     ? `Hay cambios en una reunión donde estás invitado:` :
                               `Has sido invitado a una reunión:`;

  const lines = [
    `Hola ${participantName},`,
    ``,
    intro,
    ``,
  ];

  if (action === 'rescheduled' && changes.length > 0) {
    lines.push(`Cambios:`);
    for (const c of changes) {
      const line = describeChangeText(c);
      if (line) lines.push(line);
    }
    lines.push(``);
  }

  if (action === 'cancelled' && cancelReason) {
    lines.push(`Motivo de la cancelación:`, `  ${cancelReason}`, ``);
  }

  lines.push(
    `  Título:         ${title}`,
    `  Organizado por: ${organizerName}`
  );
  if (isVirtualType) {
    lines.push(`  Modalidad:      Virtual`);
    if (meetingLink) {
      lines.push(`  Enlace:         ${meetingLink}`);
    }
  } else if (isExternalType) {
    lines.push(
      `  Modalidad:      Fuera de oficina${externalAddress ? ' (' + externalAddress + ')' : ''}`
    );
  } else {
    lines.push(
      `  Sala:           ${roomName || ''}${roomLocation ? ' (' + roomLocation + ')' : ''}`
    );
  }
  lines.push(
    `  Fecha:          ${fechaLabel}`,
    `  Horario:        ${horaLabel}`
  );
  if (description) {
    lines.push(``, `Descripción: ${description}`);
  }
  lines.push(
    ``,
    `Si tienes preguntas, contacta directamente a ${organizerName}.`,
    ``,
    `Corporación Millenium · Rooms`,
  );
  return lines.join('\n');
}

async function notifyParticipants({
  reservationId,
  reservationType,
  roomName,
  roomLocation,
  externalAddress,
  meetingLink,
  title,
  description,
  startsAt,
  endsAt,
  organizerName,
  participants,
  action,
  changes = [],
  cancelReason = '',
  cancelledInProgress = false,
}) {
  if (!participants || participants.length === 0) return;

  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const fechaLabel = formatFechaEs(start);
  const horaLabel = `${fmtHora(start)} a ${fmtHora(end)}`;

  const subjects = {
    created: `Has sido invitado a la reunión: ${title}`,
    updated: `Cambios en la reunión: ${title}`,
    rescheduled: `Reunión reagendada: ${title}`,
    cancelled: cancelledInProgress
      ? `Reunión EN CURSO cancelada: ${title}`
      : `Reunión cancelada: ${title}`,
  };

  for (const p of participants) {
    const participantName = p.full_name || p.email;

    const html = buildInvitationHtml({
      participantName,
      organizerName,
      action,
      title,
      description,
      roomName,
      roomLocation,
      reservationType,
      externalAddress,
      meetingLink,
      fechaLabel,
      horaLabel,
      changes,
      cancelReason,
      cancelledInProgress,
    });

    const text = buildInvitationText({
      participantName,
      organizerName,
      action,
      title,
      description,
      roomName,
      roomLocation,
      reservationType,
      externalAddress,
      meetingLink,
      fechaLabel,
      horaLabel,
      changes,
      cancelReason,
      cancelledInProgress,
    });

    try {
      if (!apiKey) {
        console.log('================================');
        console.log(`[mailer dev] Invitación a ${p.email} (${action}):`);
        console.log(text);
        console.log('================================');
      } else {
        await sgMail.send({
          to: p.email,
          from: {
            email: process.env.SENDGRID_FROM_EMAIL,
            name: process.env.SENDGRID_FROM_NAME,
          },
          subject: subjects[action] || subjects.created,
          text,
          html,
        });
      }

      try {
        const pool = await getPool();
        await pool
          .request()
          .input('rId', sql.Int, reservationId)
          .input('uId', sql.Int, p.user_id)
          .query(`UPDATE core.reservation_participants
                  SET notified_at = SYSDATETIME()
                  WHERE reservation_id = @rId AND user_id = @uId`);
      } catch (e) {
        console.warn(`[mailer] No fue posible marcar notified_at para user ${p.user_id}: ${e.message}`);
      }
    } catch (err) {
      console.error(`[mailer] Fallo envio a ${p.email}: ${err.message}`);
    }
  }
}

// ============================================================================
//                CORREO AL ORGANIZADOR — PARTICIPACION CANCELADA
// ============================================================================

async function sendParticipationCancelledEmail({
  organizerEmail,
  organizerName,
  cancellerName,
  cancellerEmail,
  reservationTitle,
  startsAt,
  endsAt,
  reason,
  inProgress,
}) {
  if (!organizerEmail) return;

  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const fechaLabel = formatFechaEs(start);
  const horaLabel = `${fmtHora(start)} a ${fmtHora(end)}`;

  const subject = inProgress
    ? `${cancellerName} salió de una reunión en curso: "${reservationTitle}"`
    : `${cancellerName} canceló su participación en "${reservationTitle}"`;

  const headerColor = inProgress ? "#C0392B" : "#E67E22";
  const headerText = inProgress
    ? "Salida durante reunión en curso"
    : "Cancelación de participación";

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F5F5F5;font-family:Inter,Arial,sans-serif;color:#1A1A1A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="background:${headerColor};padding:24px 32px;color:#ffffff;">
          <p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Corporación Millenium · Rooms</p>
          <h1 style="margin:8px 0 0 0;font-size:22px;font-weight:600;">${headerText}</h1>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(organizerName)},</p>
          <p style="margin:0 0 20px 0;font-size:15px;">
            <strong>${escapeHtml(cancellerName)}</strong> (${escapeHtml(cancellerEmail)}) canceló su participación en tu reunión.
          </p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
            <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Reunión</td></tr>
            <tr><td style="padding:0 0 12px 0;font-size:15px;font-weight:500;">${escapeHtml(reservationTitle)}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Fecha</td></tr>
            <tr><td style="padding:0 0 12px 0;font-size:15px;">${escapeHtml(fechaLabel)}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Horario</td></tr>
            <tr><td style="padding:0;font-size:15px;">${escapeHtml(horaLabel)}</td></tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FEF3C7;border-left:3px solid #F59E0B;border-radius:8px;padding:12px;margin-bottom:16px;">
            <tr><td style="font-size:13px;color:#78350F;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:6px;">Motivo</td></tr>
            <tr><td style="font-size:14px;color:#1F2937;line-height:1.5;">${escapeHtml(reason)}</td></tr>
          </table>
          <p style="margin:24px 0 0 0;font-size:13px;color:#7F8C8D;">Si tienes preguntas, contacta directamente a ${escapeHtml(cancellerEmail)}.</p>
        </td></tr>
        <tr><td style="border-top:1px solid #eee;padding:16px;text-align:center;font-size:12px;color:#7F8C8D;">
          Corporación Millenium &copy; ${new Date().getFullYear()}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
    `Hola ${organizerName},\n\n` +
    `${cancellerName} (${cancellerEmail}) canceló su participación en tu reunión.\n\n` +
    `  Reunión: ${reservationTitle}\n` +
    `  Fecha:   ${fechaLabel}\n` +
    `  Horario: ${horaLabel}\n\n` +
    `Motivo: ${reason}\n\n` +
    `Si tienes preguntas, contacta directamente a ${cancellerEmail}.\n\n` +
    `Corporación Millenium · Rooms`;

  if (!apiKey) {
    console.log("================================");
    console.log(`[mailer dev] Cancelación de ${cancellerName} → ${organizerEmail}`);
    console.log(text);
    console.log("================================");
    return;
  }

  await sgMail.send({
    to: organizerEmail,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME,
    },
    subject,
    text,
    html,
    replyTo: cancellerEmail,
  });
}

// ============================================================================
//                INVITADOS EXTERNOS
// ============================================================================

function buildGuestEmailFrame({ headerColor, headerText, bodyHtml, footerYear }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F5F5F5;font-family:Inter,Arial,sans-serif;color:#1A1A1A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="background:${headerColor};padding:24px 32px;color:#ffffff;">
          <p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Corporación Millenium · Rooms</p>
          <h1 style="margin:8px 0 0 0;font-size:22px;font-weight:600;">${headerText}</h1>
        </td></tr>
        <tr><td style="padding:28px 32px;">${bodyHtml}</td></tr>
        <tr><td style="border-top:1px solid #eee;padding:16px;text-align:center;font-size:12px;color:#7F8C8D;">
          Corporación Millenium &copy; ${footerYear}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

async function sendGuestInvitationEmail({
  to,
  guestName,
  reservationTitle,
  startsAt,
  endsAt,
  location,
  meetingLink,
  organizerName,
  organizerEmail,
}) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const fechaLabel = formatFechaEs(start);
  const horaLabel = `${fmtHora(start)} a ${fmtHora(end)}`;
  const subject = `Invitación: ${reservationTitle}`;

  const bodyHtml = `
    <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(guestName)},</p>
    <p style="margin:0 0 20px 0;font-size:15px;"><strong>${escapeHtml(organizerName)}</strong> te invita a la siguiente reunión:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Asunto</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;font-weight:500;">${escapeHtml(reservationTitle)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Fecha</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;">${escapeHtml(fechaLabel)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Horario</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;font-weight:500;">${escapeHtml(horaLabel)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Lugar</td></tr>
      <tr><td style="padding:0 0 ${meetingLink ? "12px" : "0"} 0;font-size:15px;">${escapeHtml(location || "Por confirmar")}</td></tr>
      ${meetingLink ? `<tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Enlace</td></tr><tr><td style="padding:0;font-size:15px;"><a href="${escapeHtml(meetingLink)}" style="color:#2C3E50;text-decoration:underline;word-break:break-all;">${escapeHtml(meetingLink)}</a></td></tr>` : ""}
    </table>
    <p style="margin:24px 0 0 0;font-size:13px;color:#7F8C8D;">Si tienes preguntas, responde a este correo o contacta a ${escapeHtml(organizerEmail)}.</p>
  `;

  const html = buildGuestEmailFrame({
    headerColor: "#2C3E50",
    headerText: "Invitación a reunión",
    bodyHtml,
    footerYear: new Date().getFullYear(),
  });

  const text =
    `Hola ${guestName},\n\n` +
    `${organizerName} te invita a la siguiente reunión:\n\n` +
    `  Asunto:  ${reservationTitle}\n` +
    `  Fecha:   ${fechaLabel}\n` +
    `  Horario: ${horaLabel}\n` +
    `  Lugar:   ${location || "Por confirmar"}\n` +
    (meetingLink ? `  Enlace:  ${meetingLink}\n` : "") +
    `\nSi tienes preguntas, contacta a ${organizerEmail}.\n\n` +
    `Corporación Millenium · Rooms`;

  if (!apiKey) {
    console.log("================================");
    console.log(`[mailer dev] Invitación externa → ${to}`);
    console.log(text);
    console.log("================================");
    return;
  }

  await sgMail.send({
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME,
    },
    subject,
    text,
    html,
    replyTo: organizerEmail,
  });
}

async function sendGuestCancellationEmail({
  to,
  guestName,
  reservationTitle,
  startsAt,
  endsAt,
  reason,
  organizerName,
  organizerEmail,
}) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const fechaLabel = formatFechaEs(start);
  const horaLabel = `${fmtHora(start)} a ${fmtHora(end)}`;
  const subject = `Reunión cancelada: ${reservationTitle}`;

  const bodyHtml = `
    <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(guestName)},</p>
    <p style="margin:0 0 20px 0;font-size:15px;">La siguiente reunión a la que estabas invitado ha sido <strong>cancelada</strong>:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Asunto</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;font-weight:500;">${escapeHtml(reservationTitle)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Fecha</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;">${escapeHtml(fechaLabel)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Horario</td></tr>
      <tr><td style="padding:0;font-size:15px;">${escapeHtml(horaLabel)}</td></tr>
    </table>
    ${
      reason
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FEE2E2;border-left:3px solid #C0392B;border-radius:8px;padding:12px;margin-bottom:16px;"><tr><td style="font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:6px;">Motivo</td></tr><tr><td style="font-size:14px;color:#1F2937;line-height:1.5;">${escapeHtml(reason)}</td></tr></table>`
        : ""
    }
    <p style="margin:24px 0 0 0;font-size:13px;color:#7F8C8D;">Cualquier consulta, contacta a ${escapeHtml(organizerEmail)}.</p>
  `;

  const html = buildGuestEmailFrame({
    headerColor: "#C0392B",
    headerText: "Reunión cancelada",
    bodyHtml,
    footerYear: new Date().getFullYear(),
  });

  const text =
    `Hola ${guestName},\n\n` +
    `La reunión a la que estabas invitado ha sido cancelada.\n\n` +
    `  Asunto:  ${reservationTitle}\n` +
    `  Fecha:   ${fechaLabel}\n` +
    `  Horario: ${horaLabel}\n` +
    (reason ? `\nMotivo: ${reason}\n` : "") +
    `\nContacto del organizador: ${organizerEmail}\n\n` +
    `Corporación Millenium · Rooms`;

  if (!apiKey) {
    console.log("================================");
    console.log(`[mailer dev] Cancelación externa → ${to}`);
    console.log(text);
    console.log("================================");
    return;
  }

  await sgMail.send({
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME,
    },
    subject,
    text,
    html,
    replyTo: organizerEmail,
  });
}

async function sendGuestRescheduledEmail({
  to,
  guestName,
  reservationTitle,
  oldStartsAt,
  oldEndsAt,
  newStartsAt,
  newEndsAt,
  location,
  meetingLink,
  organizerName,
  organizerEmail,
}) {
  const fechaNueva = formatFechaEs(new Date(newStartsAt));
  const horaNueva = `${fmtHora(new Date(newStartsAt))} a ${fmtHora(new Date(newEndsAt))}`;
  const fechaVieja = formatFechaEs(new Date(oldStartsAt));
  const horaVieja = `${fmtHora(new Date(oldStartsAt))} a ${fmtHora(new Date(oldEndsAt))}`;
  const subject = `Reunión reagendada: ${reservationTitle}`;

  const bodyHtml = `
    <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(guestName)},</p>
    <p style="margin:0 0 20px 0;font-size:15px;">La siguiente reunión a la que estás invitado ha sido <strong>reagendada</strong>:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFF3E0;border-left:3px solid #E67E22;border-radius:8px;padding:12px;margin-bottom:16px;">
      <tr><td style="font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:8px;">Cambio de horario</td></tr>
      <tr><td style="font-size:14px;line-height:1.6;">${escapeHtml(fechaVieja)} · ${escapeHtml(horaVieja)} → <strong>${escapeHtml(fechaNueva)} · ${escapeHtml(horaNueva)}</strong></td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Asunto</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;font-weight:500;">${escapeHtml(reservationTitle)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Lugar</td></tr>
      <tr><td style="padding:0 0 ${meetingLink ? "12px" : "0"} 0;font-size:15px;">${escapeHtml(location || "Por confirmar")}</td></tr>
      ${meetingLink ? `<tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Enlace</td></tr><tr><td style="padding:0;font-size:15px;"><a href="${escapeHtml(meetingLink)}" style="color:#2C3E50;text-decoration:underline;word-break:break-all;">${escapeHtml(meetingLink)}</a></td></tr>` : ""}
    </table>
    <p style="margin:24px 0 0 0;font-size:13px;color:#7F8C8D;">Si tienes preguntas, contacta a ${escapeHtml(organizerEmail)}.</p>
  `;

  const html = buildGuestEmailFrame({
    headerColor: "#E67E22",
    headerText: "Reunión reagendada",
    bodyHtml,
    footerYear: new Date().getFullYear(),
  });

  const text =
    `Hola ${guestName},\n\n` +
    `La reunión a la que estás invitado ha sido reagendada.\n\n` +
    `  Asunto:  ${reservationTitle}\n` +
    `  Antes:   ${fechaVieja} · ${horaVieja}\n` +
    `  Ahora:   ${fechaNueva} · ${horaNueva}\n` +
    `  Lugar:   ${location || "Por confirmar"}\n` +
    (meetingLink ? `  Enlace:  ${meetingLink}\n` : "") +
    `\nContacto del organizador: ${organizerEmail}\n\n` +
    `Corporación Millenium · Rooms`;

  if (!apiKey) {
    console.log("================================");
    console.log(`[mailer dev] Reagendado externa → ${to}`);
    console.log(text);
    console.log("================================");
    return;
  }

  await sgMail.send({
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME,
    },
    subject,
    text,
    html,
    replyTo: organizerEmail,
  });
}

// ============================================================================
//                TERMINADA ANTES DE TIEMPO  (G1)
// ============================================================================

async function sendMeetingEndedEarlyEmail({
  to,
  participantName,
  reservationTitle,
  originalEndsAt,
  endedAt,
  organizerName,
  organizerEmail,
  reason,
}) {
  const orig = new Date(originalEndsAt);
  const real = new Date(endedAt);
  const subject = `Reunión terminada antes de tiempo: "${reservationTitle}"`;

  const bodyHtml = `
    <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(participantName || to)},</p>
    <p style="margin:0 0 20px 0;font-size:15px;"><strong>${escapeHtml(organizerName)}</strong> finalizó la reunión antes de la hora planeada:</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Reunión</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;font-weight:500;">${escapeHtml(reservationTitle)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Hora prevista de fin</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;">${fmtHora(orig)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Hora real de fin</td></tr>
      <tr><td style="padding:0;font-size:15px;font-weight:600;">${fmtHora(real)}</td></tr>
    </table>
    ${
      reason
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FEF3C7;border-left:3px solid #F59E0B;border-radius:8px;padding:12px;margin-bottom:16px;"><tr><td style="font-size:13px;color:#78350F;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:6px;">Motivo</td></tr><tr><td style="font-size:14px;color:#1F2937;line-height:1.5;">${escapeHtml(reason)}</td></tr></table>`
        : ""
    }
    <p style="margin:24px 0 0 0;font-size:13px;color:#7F8C8D;">Si tienes preguntas, contacta a ${escapeHtml(organizerEmail)}.</p>
  `;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F5F5F5;font-family:Inter,Arial,sans-serif;color:#1A1A1A;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;padding:32px 0;"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;"><tr><td style="background:#27AE60;padding:24px 32px;color:#ffffff;"><p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Corporación Millenium · Rooms</p><h1 style="margin:8px 0 0 0;font-size:22px;font-weight:600;">Reunión terminada</h1></td></tr><tr><td style="padding:28px 32px;">${bodyHtml}</td></tr><tr><td style="border-top:1px solid #eee;padding:16px;text-align:center;font-size:12px;color:#7F8C8D;">Corporación Millenium &copy; ${new Date().getFullYear()}</td></tr></table></td></tr></table></body></html>`;

  const text =
    `Hola ${participantName || to},\n\n` +
    `${organizerName} finalizó la reunión antes de la hora planeada.\n\n` +
    `  Reunión:               ${reservationTitle}\n` +
    `  Hora prevista de fin:  ${fmtHora(orig)}\n` +
    `  Hora real de fin:      ${fmtHora(real)}\n` +
    (reason ? `\nMotivo: ${reason}\n` : "\nSin motivo indicado.\n") +
    `\nSi tienes preguntas, contacta a ${organizerEmail}.\n\n` +
    `Corporación Millenium · Rooms`;

  if (!apiKey) {
    console.log("================================");
    console.log(`[mailer dev] Terminó antes → ${to}`);
    console.log(text);
    console.log("================================");
    return;
  }

  await sgMail.send({
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME,
    },
    subject,
    text,
    html,
    replyTo: organizerEmail,
  });
}

async function sendGuestMeetingEndedEarlyEmail({
  to,
  guestName,
  reservationTitle,
  originalEndsAt,
  endedAt,
  organizerName,
  organizerEmail,
  reason,
}) {
  const orig = new Date(originalEndsAt);
  const real = new Date(endedAt);
  const subject = `Reunión terminada antes: "${reservationTitle}"`;

  const bodyHtml = `
    <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(guestName || to)},</p>
    <p style="margin:0 0 20px 0;font-size:15px;">La reunión a la que estabas invitado terminó antes de la hora planeada.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Asunto</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;font-weight:500;">${escapeHtml(reservationTitle)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Hora prevista de fin</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;">${fmtHora(orig)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Hora real de fin</td></tr>
      <tr><td style="padding:0;font-size:15px;font-weight:600;">${fmtHora(real)}</td></tr>
    </table>
    ${
      reason
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FEF3C7;border-left:3px solid #F59E0B;border-radius:8px;padding:12px;margin-bottom:16px;"><tr><td style="font-size:13px;color:#78350F;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:6px;">Motivo</td></tr><tr><td style="font-size:14px;color:#1F2937;line-height:1.5;">${escapeHtml(reason)}</td></tr></table>`
        : ""
    }
    <p style="margin:24px 0 0 0;font-size:13px;color:#7F8C8D;">Si tienes preguntas, contacta a ${escapeHtml(organizerEmail)}.</p>
  `;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F5F5F5;font-family:Inter,Arial,sans-serif;color:#1A1A1A;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;padding:32px 0;"><tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;"><tr><td style="background:#27AE60;padding:24px 32px;color:#ffffff;"><p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Corporación Millenium · Rooms</p><h1 style="margin:8px 0 0 0;font-size:22px;font-weight:600;">Reunión terminada</h1></td></tr><tr><td style="padding:28px 32px;">${bodyHtml}</td></tr><tr><td style="border-top:1px solid #eee;padding:16px;text-align:center;font-size:12px;color:#7F8C8D;">Corporación Millenium &copy; ${new Date().getFullYear()}</td></tr></table></td></tr></table></body></html>`;

  const text =
    `Hola ${guestName || to},\n\n` +
    `La reunión a la que estabas invitado terminó antes de la hora planeada.\n\n` +
    `  Asunto:                ${reservationTitle}\n` +
    `  Hora prevista de fin:  ${fmtHora(orig)}\n` +
    `  Hora real de fin:      ${fmtHora(real)}\n` +
    (reason ? `\nMotivo: ${reason}\n` : "\nSin motivo indicado.\n") +
    `\nContacto del organizador: ${organizerEmail}\n\n` +
    `Corporación Millenium · Rooms`;

  if (!apiKey) {
    console.log("================================");
    console.log(`[mailer dev] Terminó antes (guest) → ${to}`);
    console.log(text);
    console.log("================================");
    return;
  }

  await sgMail.send({
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME,
    },
    subject,
    text,
    html,
    replyTo: organizerEmail,
  });
}

// ============================================================================
//      CONFIRMACION DE USO (reuniones fantasma sin asistencia marcada)
// ============================================================================

async function sendUsageConfirmationEmail({
  to,
  organizerName,
  title,
  roomName,
  startsAt,
  endsAt,
}) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const ahora = new Date();
  const horaActual = fmtHora(ahora);
  const fechaLabel = formatFechaEs(start);
  const horaLabel = `${fmtHora(start)} a ${fmtHora(end)}`;

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const link = `${frontendUrl}/dashboard/pending-confirmation`;
  const subject = `¿La reunión "${title}" sigue en curso?`;

  const html = `
  <!doctype html>
  <html>
    <body style="margin:0;padding:0;background:#F5F5F5;font-family:Inter,Arial,sans-serif;color:#1A1A1A;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;padding:32px 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;">
              <tr>
                <td style="background:#E67E22;padding:24px 32px;color:#ffffff;">
                  <p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Corporación Millenium · Rooms</p>
                  <h1 style="margin:8px 0 0 0;font-size:22px;font-weight:600;">¿La reunión sigue en curso?</h1>
                </td>
              </tr>
              <tr>
                <td style="padding:28px 32px;">
                  <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(organizerName)},</p>
                  <p style="margin:0 0 20px 0;font-size:15px;">Son las <strong>${horaActual}</strong> y nadie marcó asistencia a tu reunión:</p>

                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
                    <tr><td style="font-size:16px;font-weight:600;padding:0 0 8px 0;">${escapeHtml(title)}</td></tr>
                    <tr><td style="font-size:14px;padding:4px 0;">📍 ${escapeHtml(roomName || "")}</td></tr>
                    <tr><td style="font-size:14px;padding:4px 0;">🕐 ${escapeHtml(fechaLabel)} · ${escapeHtml(horaLabel)}</td></tr>
                  </table>

                  <p style="margin:0 0 16px 0;font-size:14px;">Por favor confirma si la estás usando para mantener el registro al día.</p>

                  <p style="margin:24px 0 0 0;text-align:center;">
                    <a href="${escapeHtml(link)}" style="display:inline-block;background:#2C3E50;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:500;">
                      Revisar reuniones pendientes
                    </a>
                  </p>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #eee;padding:16px;text-align:center;font-size:12px;color:#7F8C8D;">
                  Equipo Rooms · Corporación Millenium &copy; ${new Date().getFullYear()}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>`;

  const text =
    `Hola ${organizerName},\n\n` +
    `Son las ${horaActual} y nadie marcó asistencia a tu reunión:\n\n` +
    `  ${title}\n` +
    `  ${roomName}\n` +
    `  ${fechaLabel} · ${horaLabel}\n\n` +
    `Por favor confirma si la estás usando.\n` +
    `Revisar: ${link}\n\n` +
    `Corporación Millenium · Rooms`;

  if (!apiKey) {
    console.log("================================");
    console.log(`[mailer dev] Confirmación de uso → ${to}`);
    console.log(text);
    console.log("================================");
    return;
  }

  await sgMail.send({
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME,
    },
    subject,
    text,
    html,
  });
}

// ============================================================================
//                   RECORDATORIOS AUTOMATICOS (24h / 15m)
// ============================================================================

async function sendReminderEmail({
  to,
  recipientName,
  reservation,
  hoursUntil, // 24 o 0.25 (15min)
}) {
  const start = new Date(reservation.starts_at);
  const end = new Date(reservation.ends_at);
  const fechaLabel = formatFechaEs(start);
  const horaLabel = `${fmtHora(start)} a ${fmtHora(end)}`;
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
  const link = `${frontendUrl}/dashboard`;

  const is24h = hoursUntil >= 1;
  const subject = is24h
    ? `Recordatorio: reunión mañana a las ${fmtHora(start)}`
    : `Tu reunión empieza en 15 minutos`;

  let locationBlock = "";
  let locationText = "";
  if (reservation.reservation_type === "physical") {
    locationBlock = `📍 <strong>${escapeHtml(reservation.room_name || "")}</strong>${reservation.room_location ? " · " + escapeHtml(reservation.room_location) : ""}`;
    locationText = `Sala: ${reservation.room_name || ""}${reservation.room_location ? " (" + reservation.room_location + ")" : ""}`;
  } else if (reservation.reservation_type === "virtual") {
    locationBlock = `💻 <strong>Reunión virtual</strong>`;
    locationText = `Reunión virtual`;
    if (reservation.meeting_link) {
      locationBlock += `<br><a href="${escapeHtml(reservation.meeting_link)}" style="color:#2C3E50;">Unirse a la reunión</a>`;
      locationText += `\n  Enlace: ${reservation.meeting_link}`;
    }
  } else if (reservation.reservation_type === "external") {
    const placeName = reservation.external_company || "Fuera de oficina";
    locationBlock = `📍 <strong>${escapeHtml(placeName)}</strong>`;
    locationText = `Fuera de oficina: ${placeName}`;
    if (reservation.external_address) {
      locationBlock += `<br>${escapeHtml(reservation.external_address)}`;
      locationText += `\n  Dirección: ${reservation.external_address}`;
    }
    if (reservation.external_maps_url) {
      locationBlock += `<br><a href="${escapeHtml(reservation.external_maps_url)}" style="color:#2C3E50;">Ver en mapa</a>`;
      locationText += `\n  Mapa: ${reservation.external_maps_url}`;
    }
  }

  const accent = is24h ? "#2C3E50" : "#E67E22";
  const intro = is24h
    ? `Te recordamos que <strong>mañana</strong> tienes la siguiente reunión:`
    : `Tu reunión empieza <strong>en 15 minutos</strong>:`;
  const introText = is24h
    ? `Te recordamos que mañana tienes la siguiente reunión:`
    : `Tu reunión empieza en 15 minutos:`;

  const html = `
  <!doctype html>
  <html>
    <body style="margin:0;padding:0;background:#F5F5F5;font-family:Inter,Arial,sans-serif;color:#1A1A1A;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;padding:32px 0;">
        <tr>
          <td align="center">
            <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;">
              <tr>
                <td style="background:${accent};padding:24px 32px;color:#ffffff;">
                  <p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Corporación Millenium · Rooms</p>
                  <h1 style="margin:8px 0 0 0;font-size:22px;font-weight:600;">${is24h ? "Recordatorio" : "Tu reunión está por empezar"}</h1>
                </td>
              </tr>
              <tr>
                <td style="padding:28px 32px;">
                  <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(recipientName)},</p>
                  <p style="margin:0 0 20px 0;font-size:15px;">${intro}</p>

                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
                    <tr><td style="font-size:16px;font-weight:600;padding:0 0 8px 0;">${escapeHtml(reservation.title)}</td></tr>
                    <tr><td style="font-size:14px;padding:4px 0;">🕐 ${escapeHtml(fechaLabel)} · ${escapeHtml(horaLabel)}</td></tr>
                    <tr><td style="font-size:14px;padding:4px 0;">${locationBlock}</td></tr>
                  </table>

                  <p style="margin:24px 0 0 0;text-align:center;">
                    <a href="${escapeHtml(link)}" style="display:inline-block;background:#2C3E50;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:500;">
                      Ver en la app
                    </a>
                  </p>
                </td>
              </tr>
              <tr>
                <td style="border-top:1px solid #eee;padding:16px;text-align:center;font-size:12px;color:#7F8C8D;">
                  Equipo Rooms · Corporación Millenium &copy; ${new Date().getFullYear()}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
  </html>`;

  const text =
    `Hola ${recipientName},\n\n` +
    `${introText}\n\n` +
    `  Título: ${reservation.title}\n` +
    `  ${locationText}\n` +
    `  Fecha: ${fechaLabel}\n` +
    `  Horario: ${horaLabel}\n\n` +
    `Ver en la app: ${link}\n\n` +
    `Corporación Millenium · Rooms`;

  if (!apiKey) {
    console.log("================================");
    console.log(`[mailer dev] Recordatorio ${is24h ? "24h" : "15m"} → ${to}`);
    console.log(text);
    console.log("================================");
    return;
  }

  await sgMail.send({
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME,
    },
    subject,
    text,
    html,
  });
}

// ============================================================================
//                INVITACIÓN CON BLOQUEO PERSONAL
// ============================================================================

async function sendBlockedInvitationEmail({
  to,
  recipientName,
  organizerName,
  meetingTitle,
  startsAt,
  endsAt,
  blockName,
}) {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const fechaLabel = formatFechaEs(start);
  const horaLabel = `${fmtHora(start)} a ${fmtHora(end)}`;
  const subject = `Invitación con bloqueo: ${meetingTitle}`;
  const requestsUrl = `${process.env.FRONTEND_URL || ""}/dashboard/my-requests`;

  const bodyHtml = `
    <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(recipientName)},</p>
    <p style="margin:0 0 20px 0;font-size:15px;"><strong>${escapeHtml(organizerName)}</strong> te invitó a una reunión que coincide con tu bloqueo personal <strong>&ldquo;${escapeHtml(blockName)}&rdquo;</strong>.</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Asunto</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;font-weight:500;">${escapeHtml(meetingTitle)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Fecha</td></tr>
      <tr><td style="padding:0 0 12px 0;font-size:15px;">${escapeHtml(fechaLabel)}</td></tr>
      <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Horario</td></tr>
      <tr><td style="padding:0;font-size:15px;font-weight:500;">${escapeHtml(horaLabel)}</td></tr>
    </table>
    <p style="margin:0 0 16px 0;font-size:15px;">Por favor decide si quieres participar:</p>
    <p style="margin:0;">
      <a href="${escapeHtml(requestsUrl)}" style="display:inline-block;background:#2C3E50;color:#ffffff;padding:10px 20px;text-decoration:none;border-radius:6px;font-size:14px;">Ver solicitud</a>
    </p>
    <p style="margin:24px 0 0 0;font-size:12px;color:#7F8C8D;">Si no respondes, tu ausencia se justificará automáticamente con tu bloqueo personal.</p>
  `;

  const html = buildGuestEmailFrame({
    headerColor: "#B45309",
    headerText: "Invitación con bloqueo",
    bodyHtml,
    footerYear: new Date().getFullYear(),
  });

  const text =
    `Hola ${recipientName},\n\n` +
    `${organizerName} te invitó a una reunión que coincide con tu bloqueo personal "${blockName}".\n\n` +
    `  Asunto:  ${meetingTitle}\n` +
    `  Fecha:   ${fechaLabel}\n` +
    `  Horario: ${horaLabel}\n\n` +
    `Ver tu solicitud: ${requestsUrl}\n\n` +
    `Si no respondes, tu ausencia se justificará automáticamente con tu bloqueo personal.\n\n` +
    `Corporación Millenium · Rooms`;

  if (!apiKey) {
    console.log("================================");
    console.log(`[mailer dev] Invitación con bloqueo → ${to}`);
    console.log(text);
    console.log("================================");
    return;
  }

  await sgMail.send({
    to,
    from: {
      email: process.env.SENDGRID_FROM_EMAIL,
      name: process.env.SENDGRID_FROM_NAME,
    },
    subject,
    text,
    html,
  });
}

// ============================================================================
//                CORREOS DE NOTAS Y RESUMEN COLABORATIVO
// ============================================================================

async function sendSimpleNotificationEmail({
  to, recipientName, subject, headerColor, headerTitle, leadHtml, leadText,
  reservationTitle, startsAt, endsAt, contentPreview,
}) {
  if (!to) return;
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const fechaLabel = formatFechaEs(start);
  const horaLabel = `${fmtHora(start)} a ${fmtHora(end)}`;

  const previewBlock = contentPreview
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-left:3px solid ${headerColor};border-radius:8px;padding:12px;margin-bottom:16px;">
         <tr><td style="font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:6px;">Vista previa</td></tr>
         <tr><td style="font-size:14px;color:#1F2937;line-height:1.5;white-space:pre-wrap;">${escapeHtml(contentPreview)}</td></tr>
       </table>`
    : '';

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#F5F5F5;font-family:Inter,Arial,sans-serif;color:#1A1A1A;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;">
        <tr><td style="background:${headerColor};padding:24px 32px;color:#ffffff;">
          <p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;opacity:0.85;">Corporación Millenium · Rooms</p>
          <h1 style="margin:8px 0 0 0;font-size:22px;font-weight:600;">${escapeHtml(headerTitle)}</h1>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 12px 0;font-size:15px;">Hola ${escapeHtml(recipientName)},</p>
          <p style="margin:0 0 20px 0;font-size:15px;">${leadHtml}</p>
          ${previewBlock}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F5F5;border-radius:12px;padding:16px;margin-bottom:16px;">
            <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Reunión</td></tr>
            <tr><td style="padding:0 0 12px 0;font-size:15px;font-weight:500;">${escapeHtml(reservationTitle)}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Fecha</td></tr>
            <tr><td style="padding:0 0 12px 0;font-size:15px;">${escapeHtml(fechaLabel)}</td></tr>
            <tr><td style="padding:6px 0;font-size:13px;color:#7F8C8D;text-transform:uppercase;letter-spacing:0.5px;">Horario</td></tr>
            <tr><td style="padding:0;font-size:15px;">${escapeHtml(horaLabel)}</td></tr>
          </table>
          <p style="margin:24px 0 0 0;font-size:12px;color:#7F8C8D;">Puedes controlar qué notificaciones recibes por correo desde tu perfil.</p>
        </td></tr>
        <tr><td style="border-top:1px solid #eee;padding:16px;text-align:center;font-size:12px;color:#7F8C8D;">
          Corporación Millenium &copy; ${new Date().getFullYear()}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
    `Hola ${recipientName},\n\n` +
    `${leadText}\n\n` +
    (contentPreview ? `Vista previa:\n  ${contentPreview}\n\n` : '') +
    `  Reunión: ${reservationTitle}\n` +
    `  Fecha:   ${fechaLabel}\n` +
    `  Horario: ${horaLabel}\n\n` +
    `Corporación Millenium · Rooms`;

  if (!apiKey) {
    console.log('================================');
    console.log(`[mailer dev] ${subject} → ${to}`);
    console.log(text);
    console.log('================================');
    return;
  }

  await sgMail.send({
    to,
    from: { email: process.env.SENDGRID_FROM_EMAIL, name: process.env.SENDGRID_FROM_NAME },
    subject,
    text,
    html,
  });
}

async function sendNewNoteEmail({ to, recipientName, authorName, reservationTitle, startsAt, endsAt, contentPreview }) {
  return sendSimpleNotificationEmail({
    to,
    recipientName,
    subject: `Nueva nota en "${reservationTitle}"`,
    headerColor: '#2C3E50',
    headerTitle: 'Nueva nota',
    leadHtml: `<strong>${escapeHtml(authorName)}</strong> agregó una nota a una reunión donde participas.`,
    leadText: `${authorName} agregó una nota a una reunión donde participas.`,
    reservationTitle, startsAt, endsAt, contentPreview,
  });
}

async function sendNoteReplyEmail({ to, recipientName, replierName, reservationTitle, startsAt, endsAt, contentPreview }) {
  return sendSimpleNotificationEmail({
    to,
    recipientName,
    subject: `${replierName} respondió a una nota — "${reservationTitle}"`,
    headerColor: '#2980B9',
    headerTitle: 'Respuesta a una nota',
    leadHtml: `<strong>${escapeHtml(replierName)}</strong> respondió a una nota en una reunión donde participas.`,
    leadText: `${replierName} respondió a una nota en una reunión donde participas.`,
    reservationTitle, startsAt, endsAt, contentPreview,
  });
}

async function sendSummaryUpdatedEmail({ to, recipientName, authorName, reservationTitle, startsAt, endsAt, isFirst }) {
  return sendSimpleNotificationEmail({
    to,
    recipientName,
    subject: isFirst
      ? `Resumen iniciado en "${reservationTitle}"`
      : `Nuevo punto en el resumen de "${reservationTitle}"`,
    headerColor: '#27AE60',
    headerTitle: isFirst ? 'Resumen iniciado' : 'Resumen actualizado',
    leadHtml: isFirst
      ? `<strong>${escapeHtml(authorName)}</strong> inició el resumen de una reunión donde participas.`
      : `<strong>${escapeHtml(authorName)}</strong> agregó un punto al resumen de una reunión donde participas.`,
    leadText: isFirst
      ? `${authorName} inició el resumen de una reunión donde participas.`
      : `${authorName} agregó un punto al resumen de una reunión donde participas.`,
    reservationTitle, startsAt, endsAt,
  });
}

module.exports = {
  sendLoginCode,
  notifyParticipants,
  sendParticipationCancelledEmail,
  sendGuestInvitationEmail,
  sendGuestCancellationEmail,
  sendGuestRescheduledEmail,
  sendMeetingEndedEarlyEmail,
  sendGuestMeetingEndedEarlyEmail,
  sendUsageConfirmationEmail,
  sendReminderEmail,
  sendBlockedInvitationEmail,
  sendNewNoteEmail,
  sendNoteReplyEmail,
  sendSummaryUpdatedEmail,
};
