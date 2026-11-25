#!/usr/bin/env bash
# Instalación completa en un VPS Ubuntu. Uso:  bash instalar-vps.sh wa.tudominio.com
set -e
DOM="${1:?Falta el dominio, ej: bash instalar-vps.sh wa.tudominio.com}"
# Servidores de 1 GB (Google e2-micro): crear memoria de intercambio para poder construir la imagen
if [ "$(free -m | awk '/Mem:/{print $2}')" -lt 1500 ] && ! swapon --show | grep -q .; then fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
apt-get install -y -qq caddy git >/dev/null
[ -d /opt/gateway ] || git clone https://github.com/robalomelany27/luxdra-whatsapp-gateway.git /opt/gateway
cd /opt/gateway && git pull -q
# Las credenciales se leen de dos archivos subidos con "Subir archivo" (más fácil que pegar), o se piden por teclado
H="$(eval echo ~"${SUDO_USER:-root}")"
if [ -s "$H/GATEWAY_SECRET.txt" ] && [ -s "$H/FIREBASE_JSON_una_linea.txt" ]; then
  SECRET="$(tr -d '\r\n ' < "$H/GATEWAY_SECRET.txt")"; JSON="$(tr -d '\r\n' < "$H/FIREBASE_JSON_una_linea.txt")"
  echo "Credenciales leidas de los archivos subidos."
else
  read -r -s -p "GATEWAY_SECRET: " SECRET; echo
  echo "Pegá el JSON de la cuenta de servicio (una línea) y Enter:"; read -r -s JSON; echo
fi
[ "${#SECRET}" -ge 16 ] || { echo "ERROR: GATEWAY_SECRET vacio o muy corto"; exit 1; }
case "$JSON" in '{"type":"service_account"'*) ;; *) echo "ERROR: el JSON no parece una cuenta de servicio"; exit 1;; esac
umask 077
printf 'GATEWAY_SECRET=%s\nFIREBASE_SERVICE_ACCOUNT_JSON=%s\n' "$SECRET" "$JSON" > .env
docker build -q -t luxdra-wa .
docker rm -f luxdra-wa 2>/dev/null || true
shred -u "$H/GATEWAY_SECRET.txt" "$H/FIREBASE_JSON_una_linea.txt" 2>/dev/null || true
docker run -d --name luxdra-wa --restart unless-stopped --env-file .env -p 127.0.0.1:3000:3000 luxdra-wa
printf '%s {\n  reverse_proxy 127.0.0.1:3000\n}\n' "$DOM" > /etc/caddy/Caddyfile && systemctl restart caddy
sleep 4; curl -s http://127.0.0.1:3000/health && echo " <- el servicio responde. URL: https://$DOM"
