gcloud compute addresses create guacamole-static-ip \
    --global \
    --project=lab-mobile-rdp-browser

gcloud compute addresses describe guacamole-static-ip \
    --global \
    --project=lab-mobile-rdp-browser \
    --format="value(address)"
#136.82.204.52

kubectl apply -f guacamole-backendconfig.yaml

# Associer le BackendConfig et activer le Container-Native Load Balancing (NEG)
kubectl annotate service guacamole-service -n guacamole-system \
  cloud.google.com/backend-config='{"default": "guacamole-backend-config"}' \
  cloud.google.com/neg='{"ingress": true}' --overwrite