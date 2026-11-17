#!/bin/bash
# Ouvre une session de test de bout en bout :
#   1. génère un JWT avec make-test-jwt.py
#   2. appelle POST /session/start (affiche la commande curl utilisée)
#   3. affiche l'URL wss du tunnel à coller sur le mobile de test
#
# Usage : Orchestrator/tools/start-test-session.sh [sub] [ttl_jwt] [largeur] [hauteur]
#         Orchestrator/tools/start-test-session.sh xavier 300 390 844
#
# Attention : le jeton de tunnel n'est valable que 30 s (TUNNEL_TOKEN_TTL_SECONDS).
set -euo pipefail

SUB="${1:-utilisateur-test}"
TTL="${2:-300}"
WIDTH="${3:-390}"
HEIGHT="${4:-844}"
API="${ORCHESTRATOR_API:-https://xmobile.tylshiloh.me}"
WSS="${GUAC_WS_URL:-wss://xmobile.tylshiloh.me/tunnel}"

HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== 1. JWT (sub=${SUB}, ${TTL} s)"
JWT="$(python3 "$HERE/make-test-jwt.py" "$SUB" "$TTL")"
echo "$JWT"

BODY="{\"width\":${WIDTH},\"height\":${HEIGHT}}"
echo
echo "== 2. POST ${API}/session/start"
cat <<EOF
curl -sS -X POST ${API}/session/start \\
  -H "Authorization: Bearer ${JWT}" \\
  -H "Content-Type: application/json" \\
  -d '${BODY}'
EOF
echo "(démarrage du Pod gVisor, 5 à 15 s...)"

RESP="$(curl -sS --fail-with-body -X POST "${API}/session/start" \
  -H "Authorization: Bearer ${JWT}" \
  -H "Content-Type: application/json" \
  -d "$BODY")" || { echo "Échec : ${RESP:-pas de réponse}" >&2; exit 1; }

field() { printf '%s' "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
SESSION_ID="$(field sessionId)"
TUNNEL_TOKEN="$(field tunnelToken)"
WIPE_TOKEN="$(field wipeToken)"
echo "sessionId : ${SESSION_ID}"

echo
echo "== 3. URL du tunnel (valable 30 s, à coller maintenant)"
echo "${WSS}?token=${TUNNEL_TOKEN}"

echo
echo "== Ou l'app complète avec le JWT (valable ${TTL} s)"
echo "${APP_URL:-http://localhost:8100}/?token=${JWT}"

echo
echo "== Fin de session"
cat <<EOF
curl -sS -X POST ${API}/session/${SESSION_ID}/wipe -H "X-Wipe-Token: ${WIPE_TOKEN}"
EOF
