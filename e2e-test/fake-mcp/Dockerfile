# e2e-only stand-in for a third-party MCP server (RFC 0024 M1), speaking the
# worldGraph dialect: stateless Streamable HTTP (one JSON-RPC object per POST,
# no initialize handshake, no session), bearer auth on every route including
# tools/list. It can also misbehave on purpose: a hostile description on a
# catalog tool, a 200 KB result, and a call that sleeps past the timeout.
FROM node:24-alpine

WORKDIR /app
COPY server.mjs /app/server.mjs

EXPOSE 9410
CMD ["node", "/app/server.mjs"]
