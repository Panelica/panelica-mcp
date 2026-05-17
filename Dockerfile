# syntax=docker/dockerfile:1.7
#
# Panelica MCP — Docker image
#
# Usage (stdio MCP client launching the container):
#   docker run --rm -i \
#     -e PANELICA_BASE_URL=https://your-panel-host:3002 \
#     -e PANELICA_API_KEY=pk_... \
#     -e PANELICA_API_SECRET=sk_... \
#     ghcr.io/panelica/panelica-mcp:latest
#
# The image speaks MCP over stdio. Use `-i` (interactive) so the MCP client
# can talk to the process; the container exits when the client disconnects.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY tools ./tools
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY tools/tools.json ./tools/tools.json
COPY LICENSE README.md ./

# Drop to a non-root user for defence in depth.
RUN addgroup -S mcp && adduser -S mcp -G mcp && chown -R mcp:mcp /app
USER mcp

# stdio MCP server — no exposed ports.
ENTRYPOINT ["node", "dist/index.js"]
