FROM node:20-slim

WORKDIR /app

# Copier les fichiers de dépendances et installer en mode production
COPY package*.json ./
RUN npm ci --only=production

# Copier le code source de l'orchestrateur
COPY session-manager.js guac-json-auth.js ./

EXPOSE 3000

# Exécuter avec l'utilisateur non-root intégré à l'image Node
USER node

CMD ["node", "session-manager.js"]