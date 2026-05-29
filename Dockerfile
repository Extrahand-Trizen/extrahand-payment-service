# Multi-stage Dockerfile for extrahand-payment-service
# Prisma 7.x requires Node 20.19+, 22.12+, or 24+
# Stage 1: Dependencies
FROM node:20-alpine AS dependencies

WORKDIR /app

# Copy package file (no package-lock.json - see .gitignore)
COPY package.json ./
COPY package-lock.json ./
# Install dependencies (including devDependencies for build)
RUN npm install --include=dev

# Stage 2: Build
FROM node:20-alpine AS build

WORKDIR /app

# Copy dependencies from previous stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy source code and config files
COPY package.json tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

# Generate Prisma Client
RUN npx prisma generate

# Build TypeScript
RUN npm run build

# Stage 3: Production
FROM node:20-alpine AS production

WORKDIR /app

# Install production dependencies only
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy Prisma files and generate client
COPY prisma ./prisma
RUN npx prisma generate

# Copy built application from build stage
COPY --from=build /app/dist ./dist

# Create logs directory
RUN mkdir -p logs

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose port (match PORT env in CapRover, e.g. 4009)
EXPOSE 4009

# Lenient health check to avoid restart loops: long start-period, more retries
# Uses PORT env (e.g. 4009); 127.0.0.1 to avoid DNS in container
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=5 \
  CMD node -e "const port = process.env.PORT || 4009; require('http').get(\"http://127.0.0.1:\" + port + \"/api/v1/health\", (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# Start the application
CMD ["node", "dist/server.js"]

