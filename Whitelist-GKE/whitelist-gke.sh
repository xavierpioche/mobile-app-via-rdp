# 1. Réserver une adresse IP globale statique pour l'Ingress
gcloud compute addresses create rdp-gateway-ip --global

# Afficher l'IP réservée (à faire pointer dans votre zone DNS, ex: ://votre-domaine.com)
gcloud compute addresses describe rdp-gateway-ip --global --format="value(address)"

# 2. Créer une politique de sécurité Cloud Armor (blocage par défaut)
gcloud compute security-policies create rdp-ip-whitelist \
    --description="Whitelist IP pour Guacamole et Orchestrateur"

# 3. Modifier la règle par défaut (priorité 2147483647) pour refuser tout le trafic (403)
gcloud compute security-policies rules update 2147483647 \
    --security-policy=rdp-ip-whitelist \
    --action=deny-403

# 4. Ajouter les adresses IP / plages CIDR autorisées (ex: IP de votre bureau / VPN / mobile)
gcloud compute security-policies rules create 1000 \
    --security-policy=rdp-ip-whitelist \
    --src-ip-ranges="203.0.113.10/32,198.51.100.0/24" \
    --action=allow \
    --description="IPs autorisees"
