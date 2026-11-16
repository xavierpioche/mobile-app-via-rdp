#enable autoscale
gcloud container clusters update rdp-browser-cluster \
    --location=africa-south1-a \
    --project=lab-mobile-rdp-browser \
    --node-pool=default-pool \
    --enable-autoscaling \
    --min-nodes=1 \
    --max-nodes=5

#scale manually
gcloud container clusters resize rdp-browser-cluster \
    --location=africa-south1-a \
    --project=lab-mobile-rdp-browser \
    --node-pool=default-pool \
    --num-nodes=2


