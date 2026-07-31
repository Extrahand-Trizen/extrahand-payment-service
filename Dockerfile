# Multi-stage Dockerfile for extrahand-payment-service
# Prisma 7.x + Node engines require Node 20.19+, 22.12+, or 24+
# Stage 1: Dependencies
FROM node:20-alpine AS dependencies

RUN apk add --no-cache openssl

WORKDIR /app

# Require lockfile — fail the build if package-lock.json is missing/out of sync.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Stage 2: Build
FROM node:20-alpine AS build

RUN apk add --no-cache openssl

WORKDIR /app

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

ENV POSTGRESDB_URI=postgresql://build:build@127.0.0.1:5432/build
RUN npx prisma generate
RUN npm run build

# Stage 3: Production
FROM node:20-alpine AS production

RUN apk add --no-cache openssl

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY prisma ./prisma
# Generated client lands in @prisma/client (and .prisma) — copy both from build.
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist

RUN mkdir -p logs && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 4009

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
  CMD node -e "const port = process.env.PORT || 4009; require('http').get(\"http://127.0.0.1:\" + port + \"/api/v1/health\", (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "dist/server.js"]
