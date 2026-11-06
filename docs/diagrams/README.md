# Diagrams

Generated illustrations for the design records. Each one is a Python script that
emits a self-contained HTML file with an inline SVG, so the diagram scales with
the page and needs no JS or external assets.

| Script | Output | What it shows |
|---|---|---|
| `c4_containers.py` | `c4-containers.html` | C4 container diagram: actors, the control plane (web client, Caddy, sandbox manager, OLTP, BYOK key file, skills marketplace), one per-user group of agent + key sidecar + web-search node with its two volumes, external systems (Docker Engine, model providers, operator search stack, open web) and the labelled control, data, provisioning, model and web connections between them. |

## What the C4 diagram covers

The drawing is a snapshot of the code, not of an RFC. Every box maps to a file
or to a container `sandbox_manager.py` creates; every arrow is a call that
exists. Draft and proposed RFCs with no implementation are listed only in the
`ROADMAP · NO CODE` box, never as containers. Security invariants and the
BYOK/web flows are in the two footnotes, with source paths at the bottom.

Coverage of `CHANGELOG.md` `[Unreleased]`:

| Unreleased change | Where it appears |
|---|---|
| Judge audit in the traces UI (`/inspect?report=citations` verdicts, Judge tab on demand) | Web Client "graph + Judge tab (on demand)"; agent chip "Traces + judge audit"; `pi-data-<user>` "citation runs + judge verdicts"; sidecar `/judge/decisions` → model providers |
| Web search as an isolated node, per-run authorisation, taint gate | Web-search Node, SearXNG + Camofox, Open web, web-plane edges, `KEY / WEB FLOWS` footnote |
| gVisor mandatory; `--cap-drop ALL` closes the key-delivery hop | Docker Engine, per-user sandbox caption, `SECURITY BOUNDARY` footnote |
| Random `MANAGER_TOKEN` and fail-closed startup | `SECURITY BOUNDARY` footnote |
| `CADDY_BIND` loopback bind | Caddy Gateway |
| `verify.sh` restore pins `AGENT_EGRESS=off` | Operator / Deployer |
| `pdf-text-extraction` marketplace skill | Skills Marketplace |
| Postgres loopback, `--internal` networks, iptables host wall, manager peer guard | OLTP Postgres, `SECURITY BOUNDARY` footnote |
| Uploads under `corpus/`, PDF text at ingest, `/ingest` response fix | `pi-ws-<user>` (`corpus/{raw,uploads,text,meta}`) and the IngestPipeline chip |
| 0.1.0 baseline (durable sandbox, conversations, citation gate, traces, skills, artifacts, web client) | Control plane, Agent Sandbox chips, both volumes, Docker Engine |

### Skills Marketplace: the one non-service box

`marketplace/skills/` is static host content, not a container or an HTTP
service. The edge from Web Client to Skills Marketplace is a local `node:fs`
read by the SvelteKit **server** (`frontend/src/lib/server/marketplace.ts`);
the browser never reads those files and no marketplace port exists. An install
reads the manifest and file bytes on the host, then streams each file through
Caddy (or the trusted `/resolve` path) to the agent's `POST /skills/file`, which
writes `WORKSPACE/skills/<name>/<path>` on `pi-ws-<user>` and verifies the tree
against the manifest hashes. `e2e-test/skills.sh` does not start the web app:
it seeds a session row and drives that same Caddy path with the shipped bundle
bytes. A web app deployment without `marketplace/` baked into its image renders
an empty catalog.

When a new component lands in the changelog, add it to `NODES` / `EDGES`,
regenerate both files, and extend this table. A box without a matching source
file is drift.

## Regenerate

```bash
python3 docs/diagrams/c4_containers.py
```

The script needs Python 3 with Pillow (`from PIL import ImageFont`) and the
DejaVu fonts under `/usr/share/fonts/truetype/dejavu` for its text-width
checks. It writes `c4-containers.html` next to itself and prints `WARN` lines
when a label, bullet, header tag or footnote does not fit its box, so a text
change that overflows is caught at generation time instead of by eye.

## Visual check

```bash
google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1600,1380 --screenshot=/tmp/c4.png docs/diagrams/c4-containers.html
```

The SVG viewBox is fixed at 1600x1380; the canvas is documented in
`c4_containers.py` (node boxes with `x/y/w/h`, edges by node id plus anchor side
and waypoints, all paths routed orthogonally with rounded corners). Boundary
captions sit on opaque chips: arrows pass behind them rather than striking
through the text.
