# LUXDRA WhatsApp Gateway

Servicio aparte (no vive en Netlify) que manda WhatsApps automáticos usando
[Baileys](https://github.com/WhiskeySockets/Baileys) — el protocolo de
WhatsApp Web — en vez de Twilio o la API oficial de Meta. Cada clínica conecta
**su propio número** escaneando un QR una sola vez desde LUXDRA.

**Importante — esto NO es un canal oficial de WhatsApp.** No requiere
aprobación de Meta ni trámites de Business Manager, pero tampoco tiene su
respaldo: WhatsApp puede detectar y bloquear números que manden mensajes
automatizados o masivos. Mitigaciones ya incluidas: pausa de ~1.2s entre
mensajes y tope de 150 destinatarios por envío. Aun así, evitar mandar a
listas grandes de gente que no interactuó antes con el número, y preferir
usarlo para lo transaccional (recordatorios de turno, confirmaciones) más que
para campañas masivas tipo publicidad.

## Por qué existe un servicio aparte

Baileys necesita mantener una conexión (WebSocket) siempre abierta con
WhatsApp — eso no puede vivir en Netlify Functions, que son serverless y se
apagan entre invocaciones. Este gateway sí queda prendido 24/7.

Las sesiones (credenciales de cada clínica) se guardan en **Firestore**, no en
disco — así un redeploy o restart del contenedor en Railway no borra las
sesiones ni obliga a re-escanear el QR.

## Deploy en Railway

1. Crear un proyecto nuevo en [railway.app](https://railway.app), "Deploy from
   GitHub repo" apuntando a este repo (si todavía no es un repo de Git, correr
   `git init && git add -A && git commit -m "gateway inicial"` acá adentro y
   subirlo a GitHub primero).
2. En Variables del servicio, cargar:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` — el mismo valor que ya está en Netlify.
   - `GATEWAY_SECRET` — un string random largo (ej: `openssl rand -hex 32`).
3. Railway detecta `package.json` solo y corre `npm start`. No hace falta
   Dockerfile.
4. Una vez desplegado, copiar la URL pública que da Railway (algo como
   `https://luxdra-whatsapp-gateway-production.up.railway.app`) — esa es la
   `GATEWAY_URL` que hay que cargar en las variables de entorno de **Netlify**
   (proyecto LUXDRA PRO FINALIZADO), junto con el mismo `GATEWAY_SECRET`.

## Endpoints (todos requieren header `x-gateway-secret`, salvo `/health`)

- `POST /sessions/:eId/start` → arranca (o reanuda) la sesión de esa empresa.
  Devuelve `{status, qrDataUrl, number}`. `status` es uno de: `connecting`,
  `qr_pending`, `connected`, `disconnected`.
- `GET /sessions/:eId/status` → mismo shape, sin crear una sesión nueva.
- `POST /sessions/:eId/logout` → desconecta y borra la sesión guardada
  (la próxima vez pide un QR nuevo).
- `POST /sessions/:eId/send` → `{destinatarios:[{nombre,telefono,mensaje}]}` →
  `{ok, total, resultados}` — mismo contrato que la función de Twilio, para
  que el frontend pueda tratarlas igual.

## Local

```bash
npm install
cp .env.example .env   # completar con los valores reales
npm start
```
