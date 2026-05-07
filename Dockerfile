FROM node:20-alpine

WORKDIR /app

# Install deps first (better Docker layer cache)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy app source
COPY . .

# Persistent data dir (mount as volume in Coolify)
RUN mkdir -p /app/data

# Drop privileges
RUN chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "server.js"]
