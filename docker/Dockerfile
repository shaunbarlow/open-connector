FROM node:24-alpine AS build
WORKDIR /app

# Dependency layer: manifests only, so source edits do not invalidate npm ci.
# web/package.json is required here because the root package.json declares
# "web" as an npm workspace; without it npm ci cannot resolve the workspace tree.
COPY package.json package-lock.json ./
COPY web/package.json ./web/package.json
RUN npm ci --ignore-scripts

# Source layers: change frequently, now rebuild without reinstalling.
COPY tsconfig.json vitest.config.ts vitest.setup.ts ./
COPY web ./web
COPY src ./src
COPY scripts ./scripts
COPY examples ./examples

RUN npm run generate:catalog
RUN npm run build
RUN npm run build --workspace web

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV OOMOL_CONNECT_DATA_DIR=/app/data
COPY package.json package-lock.json ./
COPY scripts/healthcheck.ts ./scripts/healthcheck.ts
COPY scripts/ensure-generated.ts ./scripts/ensure-generated.ts
COPY scripts/runtime-data.ts ./scripts/runtime-data.ts
COPY migrations ./migrations
COPY --from=build /app/src ./src
COPY --from=build /app/catalog ./catalog
COPY --from=build /app/dist ./dist
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/open-connector

RUN npm ci --omit=dev --ignore-scripts
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "scripts/healthcheck.ts"]
ENTRYPOINT ["/usr/local/bin/open-connector"]
CMD ["serve"]
