#!/bin/sh
# Launched from ~/.xinitrc on tty1.
# Logs to /var/log/screen-kiosk.log so we can debug if X drops out.
exec >>/var/log/screen-kiosk.log 2>&1
echo "=== kiosk.sh starting at $(date) ==="

xset -dpms
xset s off
xset s noblank

# Hide the cursor after 1 second of idle.
unclutter -idle 1 -root &

# Lightweight WM so chromium has a parent.
openbox-session &
sleep 1

# --no-sandbox is required because chromium runs as root here.
# --user-data-dir keeps the kiosk profile out of /root/.config and survives reboots.
exec chromium \
  --kiosk \
  --no-sandbox \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-translate \
  --disable-features=TranslateUI,Translate \
  --check-for-update-interval=31536000 \
  --overscroll-history-navigation=0 \
  --disable-pinch \
  --disable-session-crashed-bubble \
  --window-size=1280,400 \
  --window-position=0,0 \
  --user-data-dir=/var/lib/screen-chromium \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --remote-allow-origins=* \
  http://127.0.0.1:8765
