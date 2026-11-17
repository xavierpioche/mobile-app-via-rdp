# Contexte de build : racine du dépôt (le client web mobile-rdp-app/www est servi sur /test/)
#   docker build -f Orchestrator/Dockerfile .
FROM node:20-slim

WORKDIR /app

# Copier les fichiers de dépendances et installer en mode production
# (npm ci si un package-lock.json est présent, sinon npm install)
COPY Orchestrator/package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

# Code de l'orchestrateur et client web du lanceur de test
COPY Orchestrator/session-manager.js Orchestrator/auth.js Orchestrator/tunnel-token.js ./
COPY mobile-rdp-app/www ./public

# Échoue au build si un fichier JS a une erreur de syntaxe
RUN node --check session-manager.js && node --check auth.js && node --check tunnel-token.js \
    && test -f public/test.html && test -f public/index.html

EXPOSE 3000

# Exécuter avec l'utilisateur non-root intégré à l'image Node
USER node

CMD ["node", "session-manager.js"]
