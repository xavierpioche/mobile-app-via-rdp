FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

COPY guac-proxy.js ./
# Échoue au build si le fichier a une erreur de syntaxe
RUN node --check guac-proxy.js

EXPOSE 8080
USER node
CMD ["node", "guac-proxy.js"]
