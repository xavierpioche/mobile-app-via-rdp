#!/bin/bash
set -e
if [ -n "$RDP_PASSWORD" ]; then
echo "rdpuser:$RDP_PASSWORD" | chpasswd
fi

# La session X est lancée par xrdp-sesman avec un environnement neuf : les
# variables du conteneur (APP_URL) n'y arrivent pas. On écrit donc l'URL cible
# dans un fichier lisible uniquement par rdpuser, lu ensuite par ~/.xsession.
if [ -n "$APP_URL" ]; then
  install -m 600 -o rdpuser -g rdpuser /dev/null /home/rdpuser/.app_url
  printf '%s' "$APP_URL" > /home/rdpuser/.app_url
fi
# Ne pas laisser le mot de passe ni le jeton dans l'environnement des démons
unset RDP_PASSWORD APP_URL

rm -f /var/run/xrdp/*.pid
mkdir -p /var/run/dbus
rm -f /var/run/dbus/pid
dbus-uuidgen --ensure
dbus-daemon --system --fork
/usr/sbin/xrdp-sesman
exec /usr/sbin/xrdp --nodaemon
