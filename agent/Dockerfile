FROM node:24-bookworm-slim

WORKDIR /app

# Install dependencies first so the layer is cached across server edits.
# Dev dependencies (typescript, @types/node) are only for the typecheck gate,
# not the runtime: Node 24 runs the .ts sources with native type stripping.
# `docx` is a runtime library of the image, not of the server: parsing scripts
# the model writes use it through NODE_PATH (RFC 0009 D3). `unpdf` is both:
# the server derives a PDF's text at staging time (corpus.ts), and model
# scripts use it through NODE_PATH the same way.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Closed toolbox (RFC 0009 D3): the installer does not exist in the runtime
# image, so "extend the toolbox at runtime" fails with command not found
# instead of being a policy the model can argue with. The runtime libraries
# under /app/node_modules (including docx and unpdf) are untouched. Recovery
# from any image change is one `dev.sh reload` away: the image is the deploy
# unit.
RUN rm -rf /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack

COPY server.ts types.ts harness.ts model.ts tools.ts agent.ts http.ts trace.ts corpus.ts \
     uploads.ts skills.ts artifacts.ts citation-store.ts workspace-store.ts citation-run.ts \
     citation-tools.ts citation-report.ts scripts/gen-provider-catalog.mjs ./

# RFC 0012 §5.1: the BYOK catalog is generated from pi-ai's static catalogs at
# build time (same pinned version as the factories in model.ts). The manager
# extracts /app/provider-catalog.json from this image and serves it verbatim.
RUN node gen-provider-catalog.mjs > /app/provider-catalog.json && rm gen-provider-catalog.mjs

ENV WORKSPACE=/workspace \
    SESSION_DB=/data/session.sqlite \
    PORT=8080 \
    IDLE_MS=5000 \
    NODE_PATH=/app/node_modules

RUN mkdir -p /workspace /data

EXPOSE 8080

# /health replies without activating the agent, so the probe never defeats idle pause.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "/app/server.ts"]
