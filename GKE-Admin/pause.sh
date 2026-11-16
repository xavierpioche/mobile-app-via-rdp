# Mise en pause (économies) : coupe l'orchestrateur et le proxy Guacamole sans état
kubectl scale deployment rdp-orchestrator guac-proxy -n guacamole-system --replicas=0

# Reprise :
#kubectl scale deployment rdp-orchestrator -n guacamole-system --replicas=2
#kubectl scale deployment guac-proxy -n guacamole-system --replicas=3
