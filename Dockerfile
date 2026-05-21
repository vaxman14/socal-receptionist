FROM node:22-alpine

WORKDIR /app

# Install dependencies first so this layer is cached across code changes.
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

CMD ["node", "server.js"]
