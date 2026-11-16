# Cycle de vie d'une session

Diagramme de séquence d'une session de navigateur mobile isolé, de l'ouverture
de l'application jusqu'à la destruction du Pod.

Accès public via l'Ingress GKE (`xmobile.tylshiloh.me`, HTTPS / WSS) :
`/session/*` vers l'orchestrateur, `/tunnel` vers le proxy Guacamole sans état,
toute autre adresse en 404.

```mermaid
sequenceDiagram
  autonumber
  participant App as App mobile<br/>(Capacitor)
  participant Orch as Orchestrateur<br/>(2 réplicas)
  participant K8s as API Kubernetes
  participant Pod as Pod kiosque<br/>(gVisor)
  participant Proxy as GuacProxy + guacd<br/>(3 réplicas, sans état)
  participant Site as tylshiloh.me<br/>(/auth)
  participant Cron as CronJob<br/>nettoyage

  rect rgba(127,119,221,0.08)
  Note over App,Pod: Démarrage authentifié
  App->>Orch: POST /session/start, Authorization: Bearer JWT (largeur, hauteur)
  Orch->>Orch: Vérifier le JWT (HS256, aud, sub, exp, durée max 1 h), sinon 401
  Orch->>K8s: Détruire les sessions existantes de cet utilisateur (label = hash du sub)
  Orch->>K8s: Créer le Pod gVisor (APP_URL avec le JWT, mot de passe RDP aléatoire)
  K8s->>Pod: Démarrer kiosk-rdp:v4
  Note over Pod: entrypoint écrit ~/.app_url (0600), efface les variables, lance xrdp
  loop Toutes les 500 ms, 20 s max
    Orch->>K8s: Lire l'état du Pod
    K8s-->>Orch: Running + IP interne
  end
  Orch->>Orch: Jeton de tunnel AES-256-GCM (IP, mot de passe, taille, exp 30 s)
  Orch->>Orch: Jeton de destruction = HMAC(WIPE_SECRET, sessionId)
  Orch-->>App: sessionId + tunnelToken + wipeToken
  end

  rect rgba(29,158,117,0.08)
  Note over App,Site: Connexion et affichage
  App->>Proxy: WebSocket /tunnel?token=... (n'importe quel réplica, logs LB coupés)
  Proxy->>Proxy: Vérifier l'origine, déchiffrer le jeton, refuser s'il a expiré (403)
  Proxy->>Pod: guacd ouvre la connexion RDP sur 3389 (seul guac-proxy est autorisé)
  Note over Pod: xrdp-sesman ouvre la session X, .xsession lit ~/.app_url
  Pod->>Site: Chromium kiosque : GET /auth?token=JWT
  Site-->>Pod: Page auth (jeton retiré de l'URL)
  Proxy-->>App: Identifiant du tunnel puis instructions de dessin complètes
  end

  loop Navigation
    App->>Proxy: Tap, défilement, clavier, pings
    Proxy->>Pod: Événements souris et clavier (pings renvoyés au client)
    Pod-->>App: Mises à jour de l'écran (via le proxy)
  end

  rect rgba(216,90,48,0.08)
  Note over App,Cron: Fin de session
  alt Fermeture ou arrière-plan de l'app
    App->>Orch: sendBeacon /session/{id}/wipe (wipeToken en texte)
    Orch->>Orch: Vérifier le jeton et le format de l'id, sinon 403 / 400
    Orch->>K8s: Supprimer le Pod kiosque (gracePeriodSeconds 0)
  else Nouvelle session du même utilisateur
    Orch->>K8s: Ancienne session détruite au démarrage suivant
  else Perte réseau ou app tuée
    Cron->>Pod: Toutes les 5 min : connexion active sur 3389 ?
    Cron->>K8s: Aucune connexion : supprimer le Pod
  else Session trop longue
    K8s->>Pod: activeDeadlineSeconds 3600 atteint
  end
  K8s->>Pod: Destruction, volumes RAM effacés
  end
```

## Composants

| Composant | Dossier | Rôle |
|---|---|---|
| App mobile | `mobile-rdp-app/` | Client Capacitor + `guacamole-common-js`, envoie le JWT, ouvre le tunnel |
| Orchestrateur | `Orchestrator/` | Vérifie le JWT, crée et détruit les Pods, émet les jetons de tunnel et de destruction |
| Proxy Guacamole | `GuacProxy/` | WebSocket ↔ guacd, sans état, plusieurs réplicas |
| Kiosque | `Kiosque/` | Image xrdp + openbox + Chromium en mode kiosque |
| Nettoyage et isolation | `Guacamole/` | CronJob des Pods orphelins, NetworkPolicy des sessions |
| Page d'accueil web | `WebApp/` | `/auth` et `404.html` servis par le bucket `tylshiloh.me` |

## Limites connues

- Les jetons (JWT et tunnel) ne sont pas à usage unique : ils restent valables
  jusqu'à leur expiration (tunnel : 30 s). Memorystore pour Valkey permettrait
  de les rendre strictement à usage unique.
- Aucun backend d'identité n'émet encore les JWT : `Orchestrator/tools/make-test-jwt.py`
  sert pour les tests.
- La page `/auth` est statique : elle lit le JWT mais ne le vérifie pas côté serveur.
