#!/usr/bin/env bash
# Instalación completa en un VPS Ubuntu. Uso:  bash instalar-vps.sh wa.tudominio.com
set -e
DOM="${1:?Falta el dominio, ej: bash instalar-vps.sh wa.tudominio.com}"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
apt-get install -y -qq caddy git >/dev/null
[ -d /opt/gateway ] || git clone https://github.com/robalomelany27/luxdra-whatsapp-gateway.git /opt/gateway
cd /opt/gateway && git pull -q
read -r -s -p "GATEWAY_SECRET: " SECRET; echo
echo "Pegá el JSON de la cuenta de servicio (una línea) y Enter:"; read -r -s JSON; echo
umask 077
printf 'GATEWAY_SECRET=%s\nFIREBASE_SERVICE_ACCOUNT_JSON=%s\n' "$SECRET" "$JSON" > .env
docker build -q -t luxdra-wa .
docker rm -f luxdra-wa 2>/dev/null || true
docker run -d --name luxdra-wa --restart unless-stopped --env-file .env -p 127.0.0.1:3000:3000 luxdra-wa
echo "$DOM { reverse_proxy 127.0.0.1:3000 }" > /etc/caddy/Caddyfile && systemctl reload caddy
sleep 4; curl -s http://127.0.0.1:3000/health && echo " <- el servicio responde. URL: https://$DOM"
