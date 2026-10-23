# Skills marketplace

## Sub-features

- Browse platform-curated skills (bundled under `marketplace/skills/`).
- Install into your sandbox workspace; install runs a verification pass (`/api/marketplace/install`).
- Verify an installed skill against the shipped files (`/api/marketplace/verify`): `ok` / `mismatch` badges.
- Uninstall (with confirmation) and reinstall.

## How to get to it (user POV)

Sidebar → *Skills* (`/dashboard/skills`). Cards list name, version, and what the skill does; *Install* writes the files into the sandbox and toasts "installed and verified".

## Driving it with Playwright

`drive.mjs skills --state <run>/state.json` screenshots the marketplace, clicks the first `Install` button, then polls the card's `Installed v<version>` badge for up to 20 min (reloading, not trusting the in-page fetch). Measured on this stack: an install on a cold sandbox (the install itself provisions it) takes ~15-16 min; on a sandbox warmed by a chat first it is faster. If no card offers `Install` (empty marketplace, or the verify user already installed everything), the scenario records that fact and passes — read the screenshot to confirm which case you are in.

## Gotchas

- Install/verify/uninstall only affect that verify user's sandbox workspace; never drive them on a human account.
- Measured finding (2026-10-23, openrouter image): the file writes land in the sandbox within seconds, but the install POST takes 15-20+ minutes to return on a cold sandbox (the badge only appears then). The driver polls for 20 min (`--install-budget-ms` to change) and fails with a diagnosis hint. Drive `chat` first to warm the sandbox, and treat an install timeout as a product finding to triage, not as driver flakiness.
- An external `./dev.sh reload` (manager restart) mid-install breaks the in-page request chain entirely; re-drive the scenario rather than debugging a disturbed run.
- The buttons disable while one operation is in flight (`busy !== null`); do not parallel-click.
