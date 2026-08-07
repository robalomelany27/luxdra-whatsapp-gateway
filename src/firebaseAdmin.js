// Mismo patrón y misma variable de entorno (FIREBASE_SERVICE_ACCOUNT_JSON) que
// ya usan las Netlify Functions de LUXDRA (netlify/functions/lib/mp-common.js)
// — el service account de Firebase es el mismo, así que el valor que ya está
// configurado en Netlify se puede copiar tal cual a las variables de Railway.
const admin = require('firebase-admin');

function initAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Falta la variable de entorno FIREBASE_SERVICE_ACCOUNT_JSON');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  return admin.app();
}

initAdmin();
const db = admin.firestore();

module.exports = { admin, db };
