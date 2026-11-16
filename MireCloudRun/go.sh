gcloud projects add-iam-policy-binding lab-mobile-rdp-browser \
    --member="user:tylshiloh@gmail.com" \
    --role="roles/serviceusage.serviceUsageConsumer"

gcloud projects add-iam-policy-binding lab-mobile-rdp-browser \
    --member="user:tylshiloh@gmail.com" \
    --role="roles/run.sourceDeveloper"

SVC=$(gcloud builds get-default-service-account)

gcloud projects add-iam-policy-binding lab-mobile-rdp-browser \
    --member="serviceAccount:${SVC}" \
    --role="roles/run.builder"

gcloud config set run/region africa-south1

gcloud run deploy test-mobile --source . --port 8080 --allow-unauthenticated

#gcloud components install beta
#gcloud domains verify tylshiloh.me


gcloud beta run domain-mappings create \
    --service=test-mobile \
    --domain=mobile.tylshiloh.me \
    --region=africa-south1 # pas dispo en South Africa, mais dispo en Europe et US

