FROM node:22-alpine AS builder

WORKDIR /app

# Install v2 backend deps
COPY v2/package*.json ./v2/
RUN cd v2 && npm install --omit=dev

# Install and build v2 frontend
COPY v2/web/package*.json ./v2/web/
RUN cd v2/web && npm install
COPY v2/web/ ./v2/web/
ARG VITE_API_BASE=https://www.socalreceptionist.com
ARG VITE_SUPABASE_URL=https://fxjbxeckzeplixdgwbqk.supabase.co
ARG VITE_SUPABASE_ANON_KEY=placeholder
RUN cd v2/web && VITE_API_BASE=$VITE_API_BASE VITE_SUPABASE_URL=$VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY npm run build

FROM node:22-alpine

WORKDIR /app

# Copy v2 server + its node_modules
COPY --from=builder /app/v2/node_modules ./v2/node_modules
COPY v2/ ./v2/

# Copy built frontend
COPY --from=builder /app/v2/web/dist ./v2/web/dist

# Copy landing page static assets
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node

WORKDIR /app
CMD ["node", "v2/server/index.js"]
