ARG BUN_IMAGE=oven/bun@sha256:9e123d5fc069e29d519fd4c981afb61b8542ac80274771961136db1e4538d53e
FROM ${BUN_IMAGE} AS build
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY src/production ./src/production
COPY src/runtime/vault.ts ./src/runtime/vault.ts
COPY bridge/supabase/functions/waypoint-bridge/handler.ts ./bridge/supabase/functions/waypoint-bridge/handler.ts
RUN bun build --target=bun --outdir=/out src/production/server.ts src/production/worker.ts src/production/egress.ts

FROM ${BUN_IMAGE}
WORKDIR /app
COPY --from=build /out ./
USER 10000:10000
ENTRYPOINT ["bun", "--no-env-file"]
CMD ["server.js"]
