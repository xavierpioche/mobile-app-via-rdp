FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends xrdp xorgxrdp openbox chromium dbus dbus-x11 x11-xserver-utils ca-certificates fonts-liberation && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash rdpuser && echo "rdpuser:rdppassword" | chpasswd
RUN sed -i 's/allowed_users=console/allowed_users=anybody/g' /etc/X11/Xwrapper.config || true
# Politique Chromium gérée : pas de bulle de traduction (le drapeau
# --disable-features=Translate ne suffit pas sur la version Debian)
COPY chromium-policy.json /etc/chromium/policies/managed/kiosk.json
COPY entrypoint.sh /entrypoint.sh
COPY xsession.sh /home/rdpuser/.xsession
RUN chmod +x /entrypoint.sh /home/rdpuser/.xsession && chown rdpuser:rdpuser /home/rdpuser/.xsession
EXPOSE 3389
ENTRYPOINT ["/entrypoint.sh"]