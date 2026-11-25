// ══════════════════════════════════════════════════════════════════
// LUXDRA WhatsApp Gateway — servicio siempre encendido (pensado para Railway)
// que mantiene las conexiones de WhatsApp de cada clínica vía Baileys.
//
// Las Netlify Functions del sitio principal (LUXDRA PRO FINALIZADO) le pegan
// a este servidor por HTTP, nunca el navegador directo — por eso todos los
// endpoints (salvo /health) exigen el header x-gateway-secret con el mismo
// valor que GATEWAY_SECRET acá. El browser jamás conoce ese secreto.
// ══════════════════════════════════════════════════════════════════
// Baileys dispara internamente pedidos de reenvío (sendRetryRequest) cuando
// no puede desencriptar un mensaje entrante — algo frecuente y normal en
// una sesión multidispositivo. Si en ese instante el socket de ESA clínica ya
// se cortó, esa llamada interna rechaza la promesa fuera de cualquier
// try/catch nuestro. Sin este handler, esa única falla tumbaba TODO el
// proceso (y con él, el WhatsApp de todas las demás clínicas) — Railway lo
// reiniciaba y volvía a caer en segundos, dejando el gateway en crash-loop
// permanente. La reconexión de la sesión puntual ya la maneja el evento
// connection.update en sessionManager.js; acá solo evitamos que tire abajo
// a las demás.
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection (no se cae el proceso):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException (no se cae el proceso):', err?.message || err);
});

const express = require('express');
const { startSession, stopSession, sendMessage, enviarLoteEnBackground, nuevoJobId, getSession, restoreAllSessions } = require('./sessionManager');
const { normalizeArgPhone } = require('./phone');

const PORT = process.env.PORT || 3000;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET;

if (!GATEWAY_SECRET) {
  console.error('Falta la variable de entorno GATEWAY_SECRET — sin esto cualquiera podría mandar WhatsApps desde el número de tus clínicas. No arranco.');
  process.exit(1);
}

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

function requireSecret(req, res, next) {
  if (req.get('x-gateway-secret') !== GATEWAY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}
app.use(requireSecret);

app.post('/sessions/:eId/start', async (req, res) => {
  try {
    const entry = await startSession(req.params.eId, { force: req.body?.force === true || !!req.body?.phone, phone: req.body?.phone ? normalizeArgPhone(req.body.phone) : undefined });
    // con teléfono, el código se genera en segundo plano: se espera hasta ~8 s para devolverlo
    for (let i = 0; req.body?.phone && !entry.pairingCode && entry.status !== 'connected' && i < 32; i++) await new Promise(r => setTimeout(r, 250));
    res.json({ status: entry.status, qrDataUrl: entry.qrDataUrl, pairingCode: entry.pairingCode || null, number: entry.number });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/sessions/:eId/status', (req, res) => {
  const entry = getSession(req.params.eId);
  res.json({ status: entry.status, qrDataUrl: entry.qrDataUrl || null, pairingCode: entry.pairingCode || null, number: entry.number || null });
});

app.post('/sessions/:eId/logout', async (req, res) => {
  try {
    await stopSession(req.params.eId, { borrar: true });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Responde de inmediato con un jobId y sigue enviando en segundo plano (con
// pausa entre mensajes) — el progreso queda en empresas/{eId}/logEnvios,
// que el frontend ya lee directo con el SDK de Firestore.
// body: { destinatarios: [{nombre, telefono, mensaje}] }
// resp: { accepted: true, total, jobId }
app.post('/sessions/:eId/send', (req, res) => {
  const { eId } = req.params;
  const { destinatarios } = req.body || {};
  if (!Array.isArray(destinatarios) || !destinatarios.length) {
    return res.status(400).json({ error: 'Sin destinatarios' });
  }
  // Tope alto (no es un límite "seguro" mágico, es solo para evitar un envío
  // gigantesco por error de carga) — la protección real contra bloqueos está
  // en el pacing de enviarLoteEnBackground (pausas aleatorias + pausas largas
  // periódicas), no en cuántos destinatarios entran en un solo pedido.
  if (destinatarios.length > 5000) {
    return res.status(400).json({ error: 'Máximo 5000 destinatarios por envío' });
  }

  const entry = getSession(eId);
  if (entry.status !== 'connected') {
    return res.status(503).json({ error: 'no_conectado', mensaje: 'Esta clínica no tiene WhatsApp conectado. Escaneá el QR desde Configuración.' });
  }

  const jobId = nuevoJobId();
  res.json({ accepted: true, total: destinatarios.length, jobId });

  enviarLoteEnBackground(eId, jobId, destinatarios).catch((e) => {
    console.error(`[${eId}] error en envío en segundo plano (job ${jobId}):`, e.message);
  });
});

// Mensaje único, sincrónico — a diferencia de /send (que es para tandas
// grandes y responde de inmediato con un jobId), acá se espera el resultado
// real antes de responder. Lo usa scheduled-automatizaciones.js para el
// recordatorio de turno de mañana: un mensaje por cita, uno a la vez, y
// necesita saber ya mismo si se mandó o no para decidir si marca la cita
// como recordatorioEnviado — igual que ya hace con el email.
app.post('/sessions/:eId/send-one', async (req, res) => {
  const { eId } = req.params;
  const { telefono, mensaje } = req.body || {};
  if (!telefono || !mensaje) return res.status(400).json({ error: 'Falta teléfono o mensaje' });

  const entry = getSession(eId);
  if (entry.status !== 'connected') {
    return res.status(503).json({ error: 'no_conectado', mensaje: 'Esta clínica no tiene WhatsApp conectado.' });
  }
  const numero = normalizeArgPhone(telefono);
  if (!numero) return res.status(400).json({ error: 'Teléfono inválido' });

  try {
    await sendMessage(eId, numero, mensaje);
    res.json({ ok: true, to: numero });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`LUXDRA WhatsApp Gateway escuchando en :${PORT}`);
  restoreAllSessions().catch(err => console.error('Error restaurando sesiones:', err.message));
});
