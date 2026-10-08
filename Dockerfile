# Proof Desk API and worker. One image; fly.toml picks the process.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
# The docker CLI talks to a separate sandbox host (DOCKER_HOST) for code verification;
# nothing untrusted runs in this container.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates docker.io openssh-client \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/mcp/package.json apps/mcp/
COPY packages/chain/package.json packages/chain/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/payments/package.json packages/payments/
COPY packages/sdk/package.json packages/sdk/
COPY packages/spec-engine/package.json packages/spec-engine/
COPY packages/verifier/package.json packages/verifier/
# tsx runs the TypeScript sources directly, so dev dependencies stay in.
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
USER node
EXPOSE 8080
CMD ["npx", "tsx", "apps/api/src/server.ts"]
