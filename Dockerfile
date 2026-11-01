# syntax=docker/dockerfile:1

# Verified official multi-platform index; all stages use the same Linux Node build.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS build-test
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --include=optional --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
COPY test/*.test.js ./test/
COPY test/fixtures/ ./test/fixtures/
# Expand the existing npm test script with serial test files: some fixtures use
# 5ms deadlines. No tests/assertions are skipped or changed; no network is allowed.
RUN --network=none npm run build && node --test --test-concurrency=1 test/*.test.js

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --include=optional --no-audit --no-fund

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build-test --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Use docker run --init for signal forwarding and child reaping in both modes.
ENTRYPOINT ["node"]
CMD ["dist/main.js"]
