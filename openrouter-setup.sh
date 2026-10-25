#!/usr/bin/env bash
# Removed by RFC 0012: the operator openrouter flow (one shared plaintext key
# mounted into every sandbox). The manager no longer mounts host secrets;
# users bring their own keys through the control plane instead:
#
#   BYOK:    Settings -> AI provider in the web app, or PUT /providers/config
#            through Caddy (needs AGENT_EGRESS=open and secrets/llm_key_kek).
#   Standalone: docker run -e OPENROUTER_MODEL=<id> \
#                 -v "$PWD/secrets:/run/secrets:ro" affido-agent:latest
#
# See README "Use a real model" and docs/rfc/0012-byok-user-selected-providers.md.
set -euo pipefail
cd "$(dirname "$0")"

cat >&2 <<'TXT'
openrouter-setup.sh was removed by RFC 0012: the manager no longer mounts
secrets/ into sandboxes.

  With the stack:   users bring their own key (Settings -> AI provider, or
                    PUT /providers/config through Caddy). Needs
                    AGENT_EGRESS=open and secrets/llm_key_kek (./dev.sh up
                    creates one).
  Without a manager: docker run -e OPENROUTER_MODEL=<id> \
                      -v "$PWD/secrets:/run/secrets:ro" affido-agent:latest

See README "Use a real model" and docs/rfc/0012-byok-user-selected-providers.md.
TXT
exit 1
