# Diagrams

Generated illustrations for the design records. Each one is a Python script that
emits a self-contained HTML file with an inline SVG, so the diagram scales with
the page and needs no JS or external assets.

| Script | Output | What it shows |
|---|---|---|
| `c4_containers.py` | `c4-containers.html` | C4 container diagram: actors, control plane (web client, Caddy, sandbox manager, OLTP), per-user agent sandbox with its volumes, external systems (Docker Engine, model API, draft connectors) and the labelled connections between them. |

## Regenerate

```bash
python3 docs/diagrams/c4_containers.py
```

The script prints `WARN` lines when a label or bullet does not fit its box, so a
text change that overflows is caught at generation time instead of by eye.

## Visual check

```bash
google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  --window-size=1400,980 --screenshot=/tmp/c4.png docs/diagrams/c4-containers.html
```

The SVG viewBox is fixed at 1400x980; the canvas is documented in
`c4_containers.py` (node boxes with `x/y/w/h`, edges by node id plus anchor side
and waypoints, all paths routed orthogonally with rounded corners).
