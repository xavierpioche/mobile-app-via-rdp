#!/bin/bash
xset s off
xset -dpms
xset s noblank
openbox &

# URL cible écrite par entrypoint.sh (APP_URL du Pod), sinon page de test
TARGET_URL="https://test-mobile-307486721124.africa-south1.run.app"
if [ -s "$HOME/.app_url" ]; then
  TARGET_URL="$(cat "$HOME/.app_url")"
fi

exec chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --kiosk --app="$TARGET_URL" --no-first-run --disable-infobars --disable-session-crashed-bubble --disable-pinch --overscroll-history-navigation=0 --window-position=0,0 --disable-features=Translate --disable-translate
