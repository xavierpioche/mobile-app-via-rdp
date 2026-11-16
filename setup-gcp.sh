#!/bin/bash -x
set -e

export PROJECT_ID="lab-mobile-rdp-browser"
export REGION="africa-south1"
export ZONE="africa-south1-a"
export CLUSTER_NAME="rdp-browser-cluster"
export REPO_NAME="rdp-browser-repo"
export REPO_ENDPOINT="${REGION}-docker.pkg.dev"
export JSON_SECRET_KEY="719770f2696fb936b802d6dbb9dadede"

gcloud config set project $PROJECT_ID
# 1. Créer le dépôt Artifact Registry pour l'image Docker
gcloud artifacts repositories create ${REPO_NAME} --repository-format=docker --location=$REGION --description="Images XRDP Chromium Kiosk"
gcloud auth configure-docker ${REPO_ENDPOINT}
# 2. Créer le cluster GKE avec Network Policy activé
gcloud container clusters create $CLUSTER_NAME --zone=$ZONE --num-nodes=1 --machine-type=e2-standard-2 --enable-network-policy
# 3. Ajouter un pool de nœuds gVisor (isolation MicroVM)
gcloud container node-pools create gvisor-pool --cluster=$CLUSTER_NAME --zone=$ZONE --machine-type=e2-standard-4 --sandbox type=gvisor --enable-autoscaling --min-nodes=1 --max-nodes=10
# 4. Récupérer les identifiants kubectl et créer les namespaces
gcloud container clusters get-credentials $CLUSTER_NAME --zone=$ZONE
kubectl create namespace rdp-sessions
kubectl create namespace guacamole-system
#gcloud container clusters get-credentials $CLUSTER_NAME --location=$ZONE