FROM node:24-alpine

# e2e-only fake OpenAI-compatible upstream (RFC 0012 §10 M2). Never part of the
# control plane: verify.sh builds it, attaches it to per-user sandbox networks
# through FAKE_UPSTREAM_CONTAINER, and removes it afterwards.
COPY server.mjs /app/server.mjs

ENV PORT=8090

CMD ["node", "/app/server.mjs"]
