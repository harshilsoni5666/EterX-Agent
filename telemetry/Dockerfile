FROM node:24-bookworm-slim

WORKDIR /app/telemetry
COPY telemetry/package.json telemetry/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY telemetry/*.mjs telemetry/schema.sql ./
COPY src/lib/telemetry/protocol.ts /app/src/lib/telemetry/protocol.ts
COPY src/lib/usage/bundled-rates.json /app/src/lib/usage/bundled-rates.json

USER node
CMD ["node", "receiver.mjs"]
