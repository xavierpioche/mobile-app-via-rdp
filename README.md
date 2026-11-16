# mobile-app-via-rdp

Navigateur web isolé et éphémère pour application mobile : chaque session est un
Chromium en mode kiosque dans un Pod GKE sécurisé par gVisor, affiché sur le
téléphone via le protocole Guacamole (HTML5 RDP).

- [Cycle de vie d'une session (diagramme de séquence)](docs/sequence-session.md)
