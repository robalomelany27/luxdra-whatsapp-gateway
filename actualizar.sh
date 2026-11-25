#!/usr/bin/env bash
# Actualiza el gateway en el VPS: bash /opt/gateway/actualizar.sh
set -e
cd /opt/gateway && git pull -q
docker build -q -t luxdra-wa .
docker rm -f luxdra-wa 2>/dev/null || true
docker run -d --name luxdra-wa --restart unless-stopped --env-file .env -p 127.0.0.1:3000:3000 luxdra-wa
sleep 4; curl -s http://127.0.0.1:3000/health && echo " <- actualizado"
