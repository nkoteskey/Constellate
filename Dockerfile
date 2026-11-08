# Constellate's MCP server in a container, over stdio:
#   docker build -t constellate-mcp .
#   docker run -i --rm -v constellate-data:/data constellate-mcp
# Used by MCP directories that run servers in containers (the Docker MCP Catalog, Glama).
# With no x0x daemon to reach it works from its starter library and your own local records;
# set X0X_API and X0X_TOKEN to join the network through a daemon you run.
# CI checks the image answers an MCP handshake (scripts/container-smoke.mjs).

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY data ./data
COPY desktop/scripts ./desktop/scripts
# The same build as the npm package (prepack): compile, then sign the starter library.
RUN npm run build && node desktop/scripts/starter.mjs starter/starter.cbor && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
# In a container (MCP directories start it to list the tools), x0x isn't set up on its own: the agent gets
# network_join to join when it's really used (docs/NETWORK.md).
ENV NODE_ENV=production CONSTELLATE_HOME=/data CONSTELLATE_X0X=ask
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/starter ./starter
COPY --from=build /app/data/seed/LICENSES ./data/seed/LICENSES
COPY README.md LICENSE-MIT LICENSE-APACHE ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
ENTRYPOINT ["node", "dist/cli.js", "mcp"]
