// Convierte cualquier formato de teléfono argentino a los dígitos que espera
// el jid de WhatsApp (549 + código de área + número, sin '+' ni espacios).
// Mismo criterio que normalizeArgPhone() en send-whatsapp.js (Twilio), para
// que ambos caminos traten los números de la misma forma.
function normalizeArgPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0')) d = d.slice(1);
  if (!d.startsWith('54')) d = '54' + d;
  if (d.startsWith('54') && !d.startsWith('549') && d.length <= 12) d = '549' + d.slice(2);
  return d;
}

module.exports = { normalizeArgPhone };
