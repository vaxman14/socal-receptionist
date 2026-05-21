# SoCal Receptionist V2 — backend API service.
# Build context is the v2/ directory (set via `source_dir: v2` in the DO spec).

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

# server/index.js hosts the web service: Stripe + Twilio webhooks, onboarding
# and admin APIs. With RUN_WORKER=true it also runs the provisioning worker
# in-process, so this single container is the whole backend.
CMD ["node", "server/index.js"]
