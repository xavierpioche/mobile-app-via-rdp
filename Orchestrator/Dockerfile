FROM node:20-slim

WORKDIR /app

# Copier les fichiers de dépendances et installer en mode production
# (npm ci si un package-lock.json est présent, sinon npm install)
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

# Copier le code source de l'orchestrateur
COPY session-manager.js auth.js tunnel-token.js ./

# Échoue au build si un fichier JS a une erreur de syntaxe
RUN node --check session-manager.js && node --check auth.js && node --check tunnel-token.js

EXPOSE 3000

# Exécuter avec l'utilisateur non-root intégré à l'image Node
USER node

CMD ["node", "session-manager.js"]
