#!/bin/bash
set -e
if [ -n "$RDP_PASSWORD" ]; then
echo "rdpuser:$RDP_PASSWORD" | chpasswd
fi
rm -f /var/run/xrdp/*.pid
mkdir -p /var/run/dbus
rm -f /var/run/dbus/pid
dbus-uuidgen --ensure
dbus-daemon --system --fork
/usr/sbin/xrdp-sesman
exec /usr/sbin/xrdp --nodaemon