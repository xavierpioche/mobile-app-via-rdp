# Redéployer tout « from scratch »

Deux étapes : `deploy/bootstrap.sh` crée l'infrastructure (une seule fois), puis
Cloud Build construit les images et crée une release **Cloud Deploy** qui applique
tous les manifestes Kubernetes sur le cluster.

```
bootstrap.sh ──► APIs, Artifact Registry, GKE + pool gVisor, IP statique,
                 namespaces, secrets, compte de service, pipeline Cloud Deploy

cloudbuild.yaml ─► build kiosk-rdp / rdp-orchestrator / guac-proxy (tag = BUILD_ID)
                ─► push
                ─► gcloud deploy releases create  (paramètres : images + IP kube-dns)
                       │
Cloud Deploy ◄─────────┘  skaffold.yaml : rendu des manifestes, kubectl apply sur la cible prod
```

## 1. Infrastructure (une fois)

```bash
deploy/bootstrap.sh
```

Variables surchargeables : `PROJECT_ID`, `REGION`, `ZONE`, `CLUSTER`, `REPO`,
`PIPELINE_SA_NAME`, `STATIC_IP_NAME`, `DOMAIN`. Le script est idempotent : il ne
crée que ce qui manque, et ne régénère jamais un secret existant.

Ce qu'il crée :

| Ressource | Détail |
|---|---|
| APIs | GKE, Artifact Registry, Compute, Cloud Build, Cloud Deploy, IAM |
| Artifact Registry | `rdp-browser-repo` (Docker) |
| Cluster GKE | zonal, canal regular, VPC-native, NetworkPolicy (Calico), **NodeLocal DNSCache** |
| Pools | `default-pool` e2-standard-2 (1 à 5), `gvisor-pool` e2-standard-4 sandbox gVisor (1 à 10) |
| IP statique | `guacamole-static-ip` (globale, utilisée par l'Ingress) |
| Secrets K8s | `orchestrator-auth` (`AUTH_JWT_SECRET`, `WIPE_SECRET`), `guac-tunnel-secret` (`TUNNEL_SECRET`) générés avec `openssl rand` |
| Compte de service | `rdp-pipeline` : Artifact Registry writer, Cloud Deploy releaser + jobRunner, container.admin (RBAC des manifestes), logs, storage |
| Cloud Deploy | pipeline `rdp-browser`, cible `prod` = le cluster |

Ensuite, **à la main** : enregistrement DNS A `xmobile.tylshiloh.me` vers l'IP
affichée, en mode « DNS only » chez Cloudflare (sinon le certificat géré par
Google ne s'émet pas ; comptez jusqu'à une heure).

## 2. Déploiement (à chaque version)

Depuis la racine du dépôt :

```bash
gcloud builds submit --config=cloudbuild.yaml --region=africa-south1 \
  --service-account=projects/lab-mobile-rdp-browser/serviceAccounts/rdp-pipeline@lab-mobile-rdp-browser.iam.gserviceaccount.com .
```

Suivi : console Cloud Deploy, pipeline `rdp-browser`, ou

```bash
gcloud deploy releases list --delivery-pipeline=rdp-browser --region=africa-south1
```

### Paramètres de déploiement

Les manifestes restent applicables à la main (`kubectl apply -f`) avec leurs
valeurs par défaut. Cloud Deploy remplace les champs marqués
`# from-param: ${...}` :

| Paramètre | Fichier | Valeur fournie par Cloud Build |
|---|---|---|
| `orchestrator_image` | `Orchestrator/orchestrator-deployment.yaml` | `rdp-orchestrator:<BUILD_ID>` (contexte de build : racine du dépôt) |
| `kiosk_image` | `Orchestrator/orchestrator-deployment.yaml` (`KIOSK_IMAGE`) | `kiosk-rdp:<BUILD_ID>` |
| `proxy_image` | `GuacProxy/guac-proxy-deployment.yaml` | `guac-proxy:<BUILD_ID>` |
| `kube_dns_cidr` | `Guacamole/rdp-network-policy.yaml` | IP du service `kube-dns` du cluster `/32` |

`kube_dns_cidr` est indispensable : l'IP du service kube-dns change avec chaque
nouveau cluster, et sans elle les Pods kiosque n'ont plus de DNS.

### Manifestes appliqués (`skaffold.yaml`)

Namespaces, NetworkPolicy des sessions, CronJob de nettoyage, proxy Guacamole
(+ guacd), orchestrateur, certificat géré, FrontendConfig (redirection HTTPS),
Ingress.

## 3. Vérifier

```bash
kubectl -n guacamole-system get pods,ingress,managedcertificate
```
```bash
python3 Orchestrator/tools/make-test-jwt.py alice 300
```

Puis ouvrir l'app avec `?token=<JWT>` : la page `/auth` doit afficher `alice`.

### Lanceur de test (`https://xmobile.tylshiloh.me/test/`)

Formulaire (login fictif, URL à ouvrir dans Chromium, code de sécurité) servi par
l'orchestrateur avec le client web `mobile-rdp-app/www`. Il est désactivé tant que
le secret du code n'existe pas :

```bash
kubectl -n guacamole-system create secret generic orchestrator-test-launch \
  --from-literal=TEST_LAUNCH_CODE=<code>
kubectl -n guacamole-system rollout restart deployment rdp-orchestrator
```

(ou `TEST_LAUNCH_CODE=<code> deploy/bootstrap.sh`). Le code ne protège qu'un
environnement de test : 5 essais ratés par IP et par 10 minutes, JWT de 5 minutes.

## Hors pipeline

- **Site `tylshiloh.me`** (bucket Cloud Storage dans le projet `lab-eve-ng-453315`,
  derrière Cloudflare) : publier `WebApp/` à la main :
  `gcloud storage cp WebApp/auth.html gs://tylshiloh.me/auth --content-type="text/html; charset=utf-8" --cache-control=no-store`
  et `gcloud storage cp WebApp/404.html gs://tylshiloh.me/404.html --content-type="text/html; charset=utf-8"`.
- **Émetteur des JWT** : aucun backend d'identité n'est déployé ; il devra signer
  avec la valeur `AUTH_JWT_SECRET` du secret `orchestrator-auth`.
- **Domaine** : `xmobile.tylshiloh.me` est écrit dans `GKE-Admin/guacamole-ingress.yaml`
  et `GKE-Admin/guacamole-managed-cert.yaml` ; `tylshiloh.me/auth` dans
  `Orchestrator/session-manager.js`.
