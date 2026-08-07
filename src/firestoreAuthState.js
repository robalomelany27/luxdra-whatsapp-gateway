// ══════════════════════════════════════════════════════════════════
// Persistencia de sesión de Baileys en Firestore, en vez de en disco local
// (que es lo que hace la función de conveniencia useMultiFileAuthState() de
// Baileys). La necesitamos en Firestore y no en el filesystem del contenedor
// porque Railway (y cualquier host tipo container) puede recrear el
// filesystem en cada redeploy/restart — perder la sesión ahí obligaría a
// volver a escanear el QR cada vez que se reinicia el servicio, y con varias
// clínicas conectadas eso es inaceptable.
//
// Mismo patrón que useMultiFileAuthState: un doc para las credenciales
// (whatsappSessions/{eId}) y un doc por cada "signal key" en una subcolección
// (whatsappSessions/{eId}/keys/{tipo}-{id}) — todo en un único documento
// gigante no sirve porque una cuenta con mucha actividad genera muchas keys
// y se puede pasar del límite de 1MB por documento de Firestore.
// ══════════════════════════════════════════════════════════════════
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

// Los valores de las keys (y las creds) tienen Buffers/Uint8Array adentro,
// que Firestore no sabe guardar directo — BufferJSON los serializa como
// {type:'Buffer', data:[...]} (replacer) y los reconstruye (reviver). Como
// snap.data() ya nos da un objeto JS plano (no texto), hacemos un round-trip
// por JSON para poder pasarlo por el reviver igual que si viniera de un
// archivo — es el mismo truco que usan los adaptadores de Mongo/Postgres
// para Baileys que existen en la comunidad.
function toPlain(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}
function fromPlain(value) {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

async function useFirestoreAuthState(db, eId) {
  const sessionRef = db.collection('whatsappSessions').doc(eId);
  const keysCol = sessionRef.collection('keys');

  const credsSnap = await sessionRef.get();
  let creds = credsSnap.exists ? fromPlain(credsSnap.data()) : initAuthCreds();
  if (!credsSnap.exists) {
    await sessionRef.set(toPlain(creds), { merge: false });
  }

  const saveCreds = async () => {
    await sessionRef.set(toPlain(creds), { merge: false });
  };

  return {
    state: {
      creds, // Baileys muta este objeto en el lugar — por eso no se reasigna, se comparte la misma referencia.
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            const snap = await keysCol.doc(`${type}-${id}`).get();
            if (!snap.exists) return;
            let value = fromPlain(snap.data());
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tareas = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const ref = keysCol.doc(`${category}-${id}`);
              tareas.push(value ? ref.set(toPlain(value)) : ref.delete().catch(() => {}));
            }
          }
          await Promise.all(tareas);
        },
      },
    },
    saveCreds,
  };
}

// Borra toda la sesión guardada (creds + subcolección de keys) — se usa al
// desconectar/cerrar sesión desde la app, para forzar un QR nuevo la próxima vez.
async function borrarSesion(db, eId) {
  const sessionRef = db.collection('whatsappSessions').doc(eId);
  const keysCol = sessionRef.collection('keys');
  for (;;) {
    const snap = await keysCol.limit(500).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 500) break;
  }
  await sessionRef.delete().catch(() => {});
}

module.exports = { useFirestoreAuthState, borrarSesion };
