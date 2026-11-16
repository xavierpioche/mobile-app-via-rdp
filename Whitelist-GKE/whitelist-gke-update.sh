# Ajouter ou mettre à jour la liste des IP autorisées
gcloud compute security-policies rules update 1000 \
    --security-policy=rdp-ip-whitelist \
    --src-ip-ranges="203.0.113.10/32,198.51.100.0/24,41.188.0.0/16"
