#!/bin/bash
xset s off
xset -dpms
xset s noblank
openbox &
TARGET_URL="${APP_URL:-https://test-mobile-307486721124.africa-south1.run.app}"
exec chromium --no-sandbox --disable-dev-shm-usage --disable-gpu --kiosk --app="$TARGET_URL" --no-first-run --disable-infobars --disable-session-crashed-bubble --disable-pinch --overscroll-history-navigation=0 --window-position=0,0