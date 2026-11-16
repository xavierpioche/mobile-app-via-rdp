set -x
#APP-URL="https://test-mobile-307486721124.africa-south1.run.app"
REPO_ENDPOINT=${REGION}-docker.pkg.dev
export PROJECT_ID=$(gcloud config get-value project)
gcloud auth configure-docker $REPO_ENDPOINT

docker build -t africa-south1-docker.pkg.dev/${PROJECT_ID}/rdp-browser-repo/kiosk-rdp:${TAG:-v4} .
docker push africa-south1-docker.pkg.dev/${PROJECT_ID}/rdp-browser-repo/kiosk-rdp:${TAG:-v4}