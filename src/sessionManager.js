// ══════════════════════════════════════════════════════════════════
// Manager multi-tenant: un socket de Baileys por clínica (eId), todos
// corriendo en el mismo proceso Node. El mapa `sessions` vive en memoria —
// si el proceso se reinicia (redeploy en Railway, crash, etc.) se pierde,
// pero las credenciales están a salvo en Firestore, así que restoreAll()
// reconecta solas a todas las clínicas que ya habían escaneado el QR antes,
// sin que nadie tenga que volver a escanear nada.
// ══════════════════════════════════════════════════════════════════
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const crypto = require('crypto');
const { db } = require('./firebaseAdmin');
const { useFirestoreAuthState, borrarSesion } = require('./firestoreAuthState');
const { normalizeArgPhone } = require('./phone');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// eId -> { sock, status: 'connecting'|'qr_pending'|'connected'|'disconnected', qrDataUrl, number, startedAt }
const sessions = new Map();

function getSession(eId) {
  return sessions.get(eId) || { status: 'disconnected' };
}

async function startSession(eId, { force } = {}) {
  const existing = sessions.get(eId);
  if (existing && (existing.status === 'connected' || existing.status === 'qr_pending' || existing.status === 'connecting') && !force) {
    return existing;
  }

  const entry = { status: 'connecting', qrDataUrl: null, number: null, sock: null, startedAt: Date.now() };
  sessions.set(eId, entry);

  const { state, saveCreds } = await useFirestoreAuthState(db, eId);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    // La agenda ya se manda por email con .ics — acá no hace falta que Baileys
    // sincronice historial de chats viejos, solo necesitamos poder MANDAR.
    syncFullHistory: false,
    printQRInTerminal: false,
    browser: ['LUXDRA', 'Chrome', '1.0.0'],
  });
  entry.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      entry.status = 'qr_pending';
      entry.qrDataUrl = await QRCode.toDataURL(qr).catch(() => null);
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qrDataUrl = null;
      entry.number = sock.user?.id?.split(':')[0] || sock.user?.id || null;
      logger.info(`[${eId}] WhatsApp conectado: ${entry.number}`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      entry.status = 'disconnected';
      entry.sock = null;

      if (loggedOut) {
        // El usuario desvinculó el número desde el propio WhatsApp (o cerró
        // sesión) — no tiene sentido reintentar con las mismas credenciales,
        // hay que borrar todo y esperar que pidan un QR nuevo.
        logger.warn(`[${eId}] Sesión cerrada (logout) — se borra la sesión guardada.`);
        await borrarSesion(db, eId).catch(() => {});
        sessions.delete(eId);
      } else {
        logger.warn(`[${eId}] Conexión cortada (${statusCode || 'sin código'}), reintentando en 3s…`);
        setTimeout(() => { startSession(eId).catch(err => logger.error(`[${eId}] error reconectando: ${err.message}`)); }, 3000);
      }
    }
  });

  return entry;
}

async function stopSession(eId, { borrar } = { borrar: true }) {
  const entry = sessions.get(eId);
  if (entry?.sock) {
    try { await entry.sock.logout(); } catch (e) { /* puede tirar error si ya estaba caído, no importa */ }
    try { entry.sock.end?.(); } catch (e) {}
  }
  sessions.delete(eId);
  if (borrar) await borrarSesion(db, eId);
}

async function sendMessage(eId, telefonoE164Digits, mensaje) {
  const entry = sessions.get(eId);
  if (!entry || entry.status !== 'connected' || !entry.sock) {
    const err = new Error('WhatsApp no está conectado para esta empresa.');
    err.code = 'not_connected';
    throw err;
  }
  const jid = `${telefonoE164Digits}@s.whatsapp.net`;
  await entry.sock.sendMessage(jid, { text: mensaje });
}

// Manda una tanda de mensajes CON pausa entre cada uno (WhatsApp banea envíos
// en ráfaga) y va registrando cada resultado en empresas/{eId}/logEnvios —
// la misma colección que ya usa el resto de LUXDRA (recordatorios por email,
// etc.) y que el cliente ya lee directo con el SDK de Firestore. Se llama
// SIN await desde el endpoint HTTP, que responde de inmediato con el jobId:
// una tanda de 150 mensajes a ~1.2s cada uno tarda minutos, muy por encima
// de lo que aguanta una Netlify Function síncrona esperando la respuesta.
async function enviarLoteEnBackground(eId, jobId, destinatarios) {
  const logsRef = db.collection('empresas').doc(eId).collection('logEnvios');
  for (let i = 0; i < destinatarios.length; i++) {
    const d = destinatarios[i];
    let ok = false, error = null, telefono = null;
    if (!d.telefono || !d.mensaje) {
      error = 'sin teléfono o mensaje';
    } else {
      telefono = normalizeArgPhone(d.telefono);
      if (!telefono) {
        error = 'teléfono inválido';
      } else {
        try { await sendMessage(eId, telefono, d.mensaje); ok = true; }
        catch (e) { error = e.message; }
      }
    }
    await logsRef.add({
      tipo: 'whatsappBaileys', canal: 'whatsapp', jobId,
      destinatario: d.nombre || telefono || '?', telefono, ok, error,
      fecha: new Date().toISOString(),
    }).catch(() => {});
    if (i < destinatarios.length - 1) await sleep(1200);
  }
}

function nuevoJobId() {
  return crypto.randomUUID();
}

// Al arrancar el proceso, reconecta solas a todas las clínicas que ya tenían
// una sesión guardada en Firestore — así un redeploy/restart de Railway no
// obliga a re-escanear el QR en cada clínica.
async function restoreAllSessions() {
  const snap = await db.collection('whatsappSessions').get();
  logger.info(`Restaurando ${snap.size} sesión(es) guardada(s)...`);
  for (const doc of snap.docs) {
    startSession(doc.id).catch(err => logger.error(`[${doc.id}] error restaurando sesión: ${err.message}`));
  }
}

module.exports = { startSession, stopSession, sendMessage, enviarLoteEnBackground, nuevoJobId, getSession, restoreAllSessions };
