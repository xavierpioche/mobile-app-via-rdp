#!/bin/bash
# Prépare toute l'infrastructure GCP « from scratch », puis le pipeline Cloud Deploy.
# Idempotent : chaque ressource n'est créée que si elle n'existe pas déjà.
#
# Usage : deploy/bootstrap.sh            (valeurs par défaut ci-dessous)
#         PROJECT_ID=mon-projet deploy/bootstrap.sh
#
# Ensuite : la commande « Déployer » affichée à la fin.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-lab-mobile-rdp-browser}"
REGION="${REGION:-africa-south1}"
ZONE="${ZONE:-africa-south1-a}"
CLUSTER="${CLUSTER:-rdp-browser-cluster}"
REPO="${REPO:-rdp-browser-repo}"
PIPELINE_SA_NAME="${PIPELINE_SA_NAME:-rdp-pipeline}"
STATIC_IP_NAME="${STATIC_IP_NAME:-guacamole-static-ip}"
DOMAIN="${DOMAIN:-xmobile.tylshiloh.me}"

PIPELINE_SA="${PIPELINE_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
HERE="$(cd "$(dirname "$0")" && pwd)"

log() { printf '\n== %s\n' "$*"; }
exists() { "$@" >/dev/null 2>&1; }

gcloud config set project "$PROJECT_ID" >/dev/null

log "1. APIs"
gcloud services enable \
  container.googleapis.com artifactregistry.googleapis.com compute.googleapis.com \
  cloudbuild.googleapis.com clouddeploy.googleapis.com iam.googleapis.com \
  cloudresourcemanager.googleapis.com

log "2. Dépôt Artifact Registry ${REPO}"
exists gcloud artifacts repositories describe "$REPO" --location="$REGION" ||
  gcloud artifacts repositories create "$REPO" --repository-format=docker \
    --location="$REGION" --description="Images kiosque, orchestrateur et proxy Guacamole"

log "3. Cluster GKE ${CLUSTER} (Calico, NodeLocal DNSCache)"
exists gcloud container clusters describe "$CLUSTER" --zone="$ZONE" ||
  gcloud container clusters create "$CLUSTER" --zone="$ZONE" \
    --release-channel=regular --enable-ip-alias \
    --enable-network-policy --addons=NodeLocalDNS \
    --machine-type=e2-standard-2 --num-nodes=1 \
    --enable-autoscaling --min-nodes=1 --max-nodes=5

log "4. Pool de nœuds gVisor"
exists gcloud container node-pools describe gvisor-pool --cluster="$CLUSTER" --zone="$ZONE" ||
  gcloud container node-pools create gvisor-pool --cluster="$CLUSTER" --zone="$ZONE" \
    --machine-type=e2-standard-4 --sandbox=type=gvisor \
    --enable-autoscaling --min-nodes=1 --max-nodes=10 --num-nodes=1

gcloud container clusters get-credentials "$CLUSTER" --zone="$ZONE"

log "5. IP statique globale ${STATIC_IP_NAME}"
exists gcloud compute addresses describe "$STATIC_IP_NAME" --global ||
  gcloud compute addresses create "$STATIC_IP_NAME" --global
STATIC_IP="$(gcloud compute addresses describe "$STATIC_IP_NAME" --global --format='value(address)')"

log "6. Namespaces et secrets (générés ici, jamais dans le dépôt)"
for ns in guacamole-system rdp-sessions; do
  kubectl get namespace "$ns" >/dev/null 2>&1 || kubectl create namespace "$ns"
done
kubectl -n guacamole-system get secret orchestrator-auth >/dev/null 2>&1 ||
  kubectl -n guacamole-system create secret generic orchestrator-auth \
    --from-literal=AUTH_JWT_SECRET="$(openssl rand -hex 32)" \
    --from-literal=WIPE_SECRET="$(openssl rand -hex 32)"
kubectl -n guacamole-system get secret guac-tunnel-secret >/dev/null 2>&1 ||
  kubectl -n guacamole-system create secret generic guac-tunnel-secret \
    --from-literal=TUNNEL_SECRET="$(openssl rand -hex 32)"
# Lanceur de test /test/ : seulement si TEST_LAUNCH_CODE est fourni (sinon désactivé)
if [ -n "${TEST_LAUNCH_CODE:-}" ]; then
  kubectl -n guacamole-system get secret orchestrator-test-launch >/dev/null 2>&1 ||
    kubectl -n guacamole-system create secret generic orchestrator-test-launch \
      --from-literal=TEST_LAUNCH_CODE="$TEST_LAUNCH_CODE"
fi

log "7. Compte de service du pipeline ${PIPELINE_SA}"
exists gcloud iam service-accounts describe "$PIPELINE_SA" ||
  gcloud iam service-accounts create "$PIPELINE_SA_NAME" \
    --display-name="Pipeline Cloud Build + Cloud Deploy (mobile-app-via-rdp)"
# container.admin : les manifestes contiennent des Roles/RoleBindings RBAC
for role in roles/artifactregistry.writer roles/clouddeploy.releaser roles/clouddeploy.jobRunner \
            roles/container.admin roles/logging.logWriter roles/storage.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${PIPELINE_SA}" \
    --role="$role" --condition=None >/dev/null
done
# Le pipeline crée des releases qui s'exécutent sous ce même compte
gcloud iam service-accounts add-iam-policy-binding "$PIPELINE_SA" \
  --member="serviceAccount:${PIPELINE_SA}" --role=roles/iam.serviceAccountUser >/dev/null

log "8. Pipeline Cloud Deploy"
RENDERED="$(mktemp)"
sed -e "s|__PROJECT_ID__|${PROJECT_ID}|g" -e "s|__ZONE__|${ZONE}|g" \
    -e "s|__CLUSTER__|${CLUSTER}|g" -e "s|__PIPELINE_SA__|${PIPELINE_SA}|g" \
    "$HERE/clouddeploy.yaml" > "$RENDERED"
gcloud deploy apply --file="$RENDERED" --region="$REGION"
rm -f "$RENDERED"

cat <<EOF

Infrastructure prête.

À faire à la main :
  - DNS : enregistrement A ${DOMAIN} -> ${STATIC_IP}
    (Cloudflare en mode « DNS only », sinon le certificat géré par Google ne s'émet pas)
  - Déployer (depuis la racine du dépôt) :
      gcloud builds submit --config=cloudbuild.yaml --region=${REGION} \\
        --service-account=projects/${PROJECT_ID}/serviceAccounts/${PIPELINE_SA} .
EOF
