# e2e-only stand-in for the operator's SearXNG + Camofox. One container, two
# listeners, attached by verify.sh to the internal `websearch-in` network. The
# manager bakes its container name into the node's /etc/hosts, so both URLs use
# `http://e2e-fake-search:<port>`.
FROM node:24-alpine

WORKDIR /app
COPY server.mjs /app/server.mjs

EXPOSE 8080 9377
CMD ["node", "/app/server.mjs"]
