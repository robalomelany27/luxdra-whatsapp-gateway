# Desplegar el gateway de WhatsApp

Requisitos: una sola instancia siempre encendida y estas variables (se cargan a mano, nunca en el repositorio):
- `GATEWAY_SECRET`: el mismo valor que en Netlify.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: el JSON de la cuenta de servicio, en una línea.

## Opción A: VPS (Hetzner / DigitalOcean, 2 a 4 GB)
```bash
# en el servidor (Ubuntu)
curl -fsSL https://get.docker.com | sh
git clone <tu-repo> gateway && cd gateway
cat > .env <<'EOF'
GATEWAY_SECRET=...
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
EOF
chmod 600 .env
docker build -t luxdra-wa .
docker run -d --name luxdra-wa --restart unless-stopped --env-file .env -p 127.0.0.1:3000:3000 luxdra-wa
```
HTTPS (Caddy, un solo comando de configuración):
```bash
apt install -y caddy
echo 'wa.tudominio.com { reverse_proxy 127.0.0.1:3000 }' > /etc/caddy/Caddyfile && systemctl reload caddy
```
Apuntá el DNS `wa.tudominio.com` al IP del VPS. `GATEWAY_URL` en Netlify = `https://wa.tudominio.com`.

## Opción B: Render
1. Subí esta carpeta a un repositorio de GitHub.
2. En render.com: New, Blueprint, elegí el repositorio (usa `render.yaml`).
3. Cargá las dos variables en el panel.
4. La URL `https://luxdra-whatsapp-gateway.onrender.com` va en `GATEWAY_URL` de Netlify.

## Comprobar
`curl https://TU_URL/health` debe devolver `{"ok":true}`.
Para actualizar el código: subirlo al repositorio y reiniciar el servicio.
