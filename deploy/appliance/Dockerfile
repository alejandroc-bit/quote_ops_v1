# syntax=docker/dockerfile:1

FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/agent/package.json apps/agent/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/control-plane-api/package.json apps/control-plane-api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/criteria/package.json packages/criteria/package.json
COPY packages/knowledge/package.json packages/knowledge/package.json
COPY packages/quote-core/package.json packages/quote-core/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM deps AS builder
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/agent/package.json apps/agent/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
COPY apps/control-plane-api/package.json apps/control-plane-api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/audit/package.json packages/audit/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/criteria/package.json packages/criteria/package.json
COPY packages/knowledge/package.json packages/knowledge/package.json
COPY packages/quote-core/package.json packages/quote-core/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/apps/agent/dist apps/agent/dist
COPY --from=builder /app/apps/api/dist apps/api/dist
COPY --from=builder /app/apps/control-plane/dist apps/control-plane/dist
COPY --from=builder /app/packages/audit/dist packages/audit/dist
COPY --from=builder /app/packages/connectors/dist packages/connectors/dist
COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/criteria/dist packages/criteria/dist
COPY --from=builder /app/packages/knowledge/dist packages/knowledge/dist
COPY --from=builder /app/packages/quote-core/dist packages/quote-core/dist
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY deploy/appliance/entrypoint.sh /usr/local/bin/quoteops-entrypoint
RUN chmod +x /usr/local/bin/quoteops-entrypoint

ARG QUOTEOPS_SERVICE=api
ENV QUOTEOPS_SERVICE=${QUOTEOPS_SERVICE}
EXPOSE 8080 8081
CMD ["quoteops-entrypoint"]
