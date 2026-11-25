// ══════════════════════════════════════════════════════════════════
// Manager multi-tenant: un socket de Baileys por clínica (eId), todos
// corriendo en el mismo proceso Node. El mapa `sessions` vive en memoria —
// si el proceso se reinicia (redeploy en Railway, crash, etc.) se pierde,
// pero las credenciales están a salvo en Firestore, así que restoreAll()
// reconecta solas a todas las clínicas que ya habían escaneado el QR antes,
// sin que nadie tenga que volver a escanear nada.
// ══════════════════════════════════════════════════════════════════
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
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
// Mensajes enviados recientemente: WhatsApp los pide de nuevo cuando el destinatario no pudo descifrarlos
// ("Esperando el mensaje..."). Sin esto el reintento falla y el mensaje queda vacío.
const enviados = new Map();
function recordarEnviado(sent) { try { if (sent && sent.key && sent.key.id && sent.message) { enviados.set(sent.key.id, sent.message); if (enviados.size > 1000) enviados.delete(enviados.keys().next().value); } } catch (_) {} }

function getSession(eId) {
  return sessions.get(eId) || { status: 'disconnected' };
}

async function startSession(eId, { force, phone } = {}) {
  const existing = sessions.get(eId);
  if (existing && (existing.status === 'connected' || existing.status === 'qr_pending' || existing.status === 'connecting') && !force && !phone) {
    return existing;
  }

  const entry = { status: 'connecting', qrDataUrl: null, pairingCode: null, pairPhone: phone ? String(phone).replace(/\D/g, '') : null, number: null, sock: null, startedAt: Date.now() };
  sessions.set(eId, entry);

  const { state, saveCreds } = await useFirestoreAuthState(db, eId);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    version,
    // Con las claves en Firestore (lentas), el almacén con caché evita condiciones de carrera al cifrar/descifrar
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    // La agenda ya se manda por email con .ics — acá no hace falta que Baileys
    // sincronice historial de chats viejos, solo necesitamos poder MANDAR.
    syncFullHistory: false,
    printQRInTerminal: false,
    getMessage: async (key) => (key && enviados.get(key.id)) || undefined,
    browser: ['LUXDRA', 'Chrome', '1.0.0'],
  });
  entry.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      entry.status = 'qr_pending';
      entry.qrDataUrl = await QRCode.toDataURL(qr).catch(() => null);
      // Vincular con código (sin escanear): se pide una sola vez, cuando el socket ya está listo
      if (entry.pairPhone && !entry.pairingCode && !sock.authState.creds.registered) {
        try {
          const raw = await sock.requestPairingCode(entry.pairPhone);
          entry.pairingCode = raw ? String(raw).replace(/(.{4})(.{4})/, '$1-$2') : null;
        } catch (err) { logger.warn(`[${eId}] no se pudo generar el código de vinculación: ${err.message}`); }
      }
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qrDataUrl = null;
      entry.pairingCode = null;
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
  try { await entry.sock.presenceSubscribe(jid); await entry.sock.sendPresenceUpdate('composing', jid); await sleep(Math.min(5000, 700 + String(mensaje).length * (25 + Math.random() * 35))); await entry.sock.sendPresenceUpdate('paused', jid); } catch (_) {}
  const sent = await entry.sock.sendMessage(jid, { text: variar(mensaje) });
  recordarEnviado(sent);
}

// Pausa aleatoria entre min y max ms — un intervalo fijo (ej. siempre 1.2s)
// es exactamente el patrón que un detector de automatización busca; variarlo
// lo hace ver más humano.
function randDelay(min, max) {
  return min + Math.random() * (max - min);
}

// ── Ritmo de envío pensado para clínicas con miles de pacientes ──
// Un ritmo parejo es lo que detecta WhatsApp: acá todo varía. Cada mensaje espera un tiempo distinto
// (casi siempre 4 a 14 s, a veces más corto o más largo), antes de enviar se simula "escribiendo…"
// proporcional al largo del texto, cada tanto hay pausas largas (la cantidad de mensajes entre pausas
// también se sortea) y hay topes por hora y por día para no saturar el número.
const TOPE_POR_HORA = 150;
const TOPE_POR_DIA = 1200;
const PAUSA_LARGA_MIN_MS = 90 * 1000;    // 1,5 min
const PAUSA_LARGA_MAX_MS = 6 * 60 * 1000; // 6 min
function pausaCorta() {
  const r = Math.random();
  if (r < 0.12) return randDelay(2500, 4000);     // a veces rápido
  if (r < 0.80) return randDelay(4000, 14000);    // lo normal
  if (r < 0.95) return randDelay(14000, 30000);   // a veces lento
  return randDelay(30000, 75000);                  // y de vez en cuando se "distrae"
}
function cadaCuantoPausaLarga() { return 20 + Math.floor(Math.random() * 41); } // entre 20 y 60 mensajes
// Variación de texto opcional: "{Hola|Buen día|Qué tal} Ana" -> una de las opciones al azar
function variar(texto) { return String(texto).replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_, o) => { const p = o.split('|'); return p[Math.floor(Math.random() * p.length)]; }); }
const _ventana = new Map(); // eId -> { horas: [timestamps], dia: {fecha, n} }
async function esperarCupo(eId) {
  for (;;) {
    const v = _ventana.get(eId) || { horas: [], dia: { fecha: '', n: 0 } };
    const ahora = Date.now(), hoy = new Date().toISOString().slice(0, 10);
    v.horas = v.horas.filter(t => ahora - t < 3600e3);
    if (v.dia.fecha !== hoy) v.dia = { fecha: hoy, n: 0 };
    _ventana.set(eId, v);
    if (v.dia.n >= TOPE_POR_DIA) { await sleep(10 * 60 * 1000); continue; }   // sigue mañana
    if (v.horas.length >= TOPE_POR_HORA) { await sleep(Math.max(30e3, 3600e3 - (ahora - v.horas[0]) + 5000)); continue; }
    v.horas.push(ahora); v.dia.n++; return;
  }
}

// Manda una tanda de mensajes con pausas (WhatsApp banea envíos en ráfaga,
// sobre todo tandas grandes de 2000/4000+ a números que nunca escribieron
// antes) y va registrando cada resultado en empresas/{eId}/logEnvios — la
// misma colección que ya usa el resto de LUXDRA (recordatorios por email,
// etc.) y que el cliente ya lee directo con el SDK de Firestore. Se llama
// SIN await desde el endpoint HTTP, que responde de inmediato con el jobId:
// una tanda grande con estas pausas puede tardar horas, muy por encima de lo
// que aguanta una Netlify Function síncrona esperando la respuesta — y es a
// propósito: para un volumen así, mandar rápido es lo que provoca el bloqueo.
async function enviarLoteEnBackground(eId, jobId, destinatarios) {
  const logsRef = db.collection('empresas').doc(eId).collection('logEnvios');
  let hastaPausaLarga = cadaCuantoPausaLarga(), erroresSeguidos = 0;
  for (let i = 0; i < destinatarios.length; i++) {
    const d = destinatarios[i];
    await esperarCupo(eId);
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
    erroresSeguidos = ok ? 0 : (error && /conectad/i.test(error) ? erroresSeguidos + 1 : 0);
    if (erroresSeguidos >= 3) { // WhatsApp se desconectó: no seguir golpeando
      for (let j = i + 1; j < destinatarios.length; j++) await logsRef.add({ tipo: 'whatsappBaileys', canal: 'whatsapp', jobId, destinatario: destinatarios[j].nombre || '?', telefono: null, ok: false, error: 'Envío detenido: WhatsApp no está conectado', fecha: new Date().toISOString() }).catch(() => {});
      return;
    }
    if (i < destinatarios.length - 1) {
      hastaPausaLarga--;
      if (hastaPausaLarga <= 0) { hastaPausaLarga = cadaCuantoPausaLarga(); await sleep(randDelay(PAUSA_LARGA_MIN_MS, PAUSA_LARGA_MAX_MS)); }
      else await sleep(pausaCorta());
    }
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
