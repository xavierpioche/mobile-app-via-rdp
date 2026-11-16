kubectl apply -f - <<EOF
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: guacamole-backend-config
  namespace: guacamole-system
spec:
  healthCheck:
    checkIntervalSec: 15
    timeoutSec: 5
    healthyThreshold: 1
    unhealthyThreshold: 2
    type: HTTP
    requestPath: /guacamole/
    port: 8080
  sessionAffinity:
    affinityType: GENERATED_COOKIE
    affinityCookieTtlSec: 86400
  connectionDraining:
    drainingTimeoutSec: 60
  timeoutSec: 3600
EOF