# Build from the repository root:
#   docker build -f ops/Dockerfile -t javelin .
#   docker run -p 8080:8080 -v javelin-data:/data javelin
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/vcs/package.json packages/vcs/
COPY packages/sdk/package.json packages/sdk/
COPY packages/search/package.json packages/search/
COPY packages/provenance/package.json packages/provenance/
COPY packages/policy/package.json packages/policy/
COPY packages/agents/package.json packages/agents/
COPY packages/git-bridge/package.json packages/git-bridge/
COPY apps/javelind/package.json apps/javelind/
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json bun.lock ./
COPY packages packages
COPY apps/javelind apps/javelind
ENV JAVELIND_PORT=8080 \
    JAVELIND_ROOT=/data
VOLUME /data
EXPOSE 8080
CMD ["bun", "run", "apps/javelind/src/main.ts"]
