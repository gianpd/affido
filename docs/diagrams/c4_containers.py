#!/usr/bin/env python3
"""Generate docs/diagrams/c4-containers.html — affido C4 container diagram.

The diagram is one fixed 1400x980 SVG with a viewBox, so it scales with the
page. Nodes are declared with (x, y, w, h); edges are declared by node id plus
anchor side and offset, with optional absolute waypoints. The router turns each
edge into an orthogonal polyline and rounds the corners, so no path is drawn by
hand.

Run: python3 docs/diagrams/c4_containers.py
"""

from __future__ import annotations

import html
import math
from pathlib import Path

from PIL import ImageFont

W, H = 1400, 980
OUT = Path(__file__).resolve().with_name("c4-containers.html")

# ---------------------------------------------------------------- palette
PAPER = "#f4eddd"
PAPER_2 = "#fbf6ea"
PAPER_3 = "#ece3cd"
INK = "#22303f"
INK_SOFT = "#5a6672"
RULE = "#d3c7a8"
RULE_SOFT = "#e2d8bf"
RED = "#bd3f1d"
RED_SOFT = "#f3ddd2"
TEAL = "#0e7568"
TEAL_SOFT = "#ddeae4"
BLUE = "#2b5d92"
BLUE_SOFT = "#e0e8ef"
AMBER = "#a96f14"
AMBER_SOFT = "#f0e4c8"
MUTED_EDGE = "#8a7f6a"

# ---------------------------------------------------------------- fonts
FONT_DIR = Path("/usr/share/fonts/truetype/dejavu")
FACES = {
    ("sans", False): FONT_DIR / "DejaVuSans.ttf",
    ("sans", True): FONT_DIR / "DejaVuSans-Bold.ttf",
    ("mono", False): FONT_DIR / "DejaVuSansMono.ttf",
    ("mono", True): FONT_DIR / "DejaVuSansMono-Bold.ttf",
}
_cache: dict[tuple[str, bool, int], ImageFont.FreeTypeFont] = {}


def font(family: str, bold: bool, size: float) -> ImageFont.FreeTypeFont:
    key = (family, bold, int(round(size * 10)))
    if key not in _cache:
        _cache[key] = ImageFont.truetype(str(FACES[(family, bold)]), int(round(size)))
    return _cache[key]


def tw(text: str, size: float, *, mono: bool = False, bold: bool = False) -> float:
    return font("mono" if mono else "sans", bold, size).getlength(text)


def wrap(text: str, maxw: float, size: float, *, mono: bool = False, bold: bool = False) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        probe = f"{current} {word}".strip()
        if tw(probe, size, mono=mono, bold=bold) <= maxw or not current:
            current = probe
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def fit(lines: list[str], maxw: float, size: float, *, mono: bool = False, bold: bool = False) -> list[str]:
    out: list[str] = []
    for line in lines:
        out.extend(wrap(line, maxw, size, mono=mono, bold=bold))
    return out


def esc(text: str) -> str:
    return html.escape(text, quote=True)


def text(
    x: float,
    y: float,
    value: str,
    size: float,
    fill: str = INK,
    *,
    mono: bool = False,
    bold: bool = False,
    anchor: str = "start",
    tracking: float = 0.0,
) -> str:
    family = "DejaVu Sans Mono, monospace" if mono else "DejaVu Sans, system-ui, sans-serif"
    weight = "700" if bold else "400"
    spacing = f' letter-spacing="{tracking}"' if tracking else ""
    return (
        f'<text x="{x:.1f}" y="{y:.1f}" font-family="{family}" font-size="{size:.1f}" '
        f'font-weight="{weight}" fill="{fill}" text-anchor="{anchor}"{spacing}>{esc(value)}</text>'
    )


def rect(x, y, w, h, fill, stroke, *, rx=2, sw=1.4, dash=None) -> str:
    dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
    return (
        f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx}" '
        f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{dash_attr}/>'
    )


# ---------------------------------------------------------------- layout checks
WARNINGS: list[str] = []


def require(cond: bool, message: str) -> None:
    if not cond:
        WARNINGS.append(message)


# ---------------------------------------------------------------- nodes
NODES: dict[str, dict] = {
    "user": {
        "kind": "person",
        "x": 30,
        "y": 180,
        "w": 150,
        "h": 120,
        "title": "User / Owner",
        "tech": "browser",
        "lines": ["chat · uploads · skills", "traces · artifacts"],
    },
    "operator": {
        "kind": "person",
        "x": 30,
        "y": 620,
        "w": 150,
        "h": 118,
        "title": "Operator / Deployer",
        "tech": "shell · dev.sh",
        "lines": ["compose up · reload", "verify.sh · e2e"],
    },
    "web": {
        "kind": "container",
        "x": 225,
        "y": 165,
        "w": 245,
        "h": 140,
        "title": "Web Client",
        "tech": "SvelteKit 3 · Svelte 5 · Drizzle",
        "lines": [
            "better-auth sign-in + sessions",
            "dashboard · chat · documents",
            "skills catalog · traces · uploads",
        ],
    },
    "caddy": {
        "kind": "container",
        "x": 550,
        "y": 165,
        "w": 240,
        "h": 130,
        "title": "Caddy Gateway",
        "tech": "Caddy 2.11 · :18080 published",
        "lines": [
            "only published endpoint",
            "forward_auth → manager /resolve",
            "strips X-Sandbox-Endpoint, proxies",
        ],
    },
    "manager": {
        "kind": "container",
        "x": 550,
        "y": 355,
        "w": 240,
        "h": 140,
        "title": "Sandbox Manager",
        "tech": "Python 3.13 · psycopg · docker CLI",
        "lines": [
            "sandbox_registry: user → sandbox",
            "provisions on first request",
            "idle eviction + watchdog restart",
        ],
    },
    "oltp": {
        "kind": "container",
        "x": 840,
        "y": 355,
        "w": 180,
        "h": 140,
        "title": "OLTP Postgres",
        "tech": "postgres:17 · oltp-data",
        "lines": [
            "better-auth: user, session",
            "sandbox_registry rows",
            "chat + trace metadata",
        ],
    },
    "agent": {
        "kind": "agent",
        "x": 225,
        "y": 595,
        "w": 545,
        "h": 310,
        "title": "Agent Sandbox",
        "tech": "affido-agent:latest · node /app/server.ts · PORT=8080",
        "lines": [
            "Runs the conversation: prompt in, tool calls, cited answer and full trace out.",
            "Starts powerless: powers arrive only as installed, manifest-verified skills.",
        ],
    },
    "vol_ws": {
        "kind": "volume",
        "x": 810,
        "y": 595,
        "w": 195,
        "h": 130,
        "title": "pi-ws-<user>",
        "tech": "/workspace · docker volume",
        "lines": ["uploads/ · corpus/ · skills/", "artifacts/ — survives stop"],
    },
    "vol_data": {
        "kind": "volume",
        "x": 810,
        "y": 740,
        "w": 195,
        "h": 130,
        "title": "pi-data-<user>",
        "tech": "/data · docker volume",
        "lines": ["session.sqlite: conversations,", "traces, submissions"],
    },
    "docker": {
        "kind": "external",
        "x": 1055,
        "y": 380,
        "w": 315,
        "h": 110,
        "title": "Docker Engine",
        "tech": "host daemon · /var/run/docker.sock",
        "lines": ["Creates networks, volumes, containers", "and starts/stops them on request."],
    },
    "openrouter": {
        "kind": "external",
        "x": 1055,
        "y": 560,
        "w": 315,
        "h": 120,
        "title": "Model API",
        "tech": "OpenRouter / OpenAI · HTTPS",
        "lines": ["Chat completions + tool calls; the key", "is read from /run/secrets, never env"],
    },
    "connectors": {
        "kind": "draft",
        "x": 1055,
        "y": 720,
        "w": 315,
        "h": 120,
        "title": "Gmail API · WhatsApp bridge",
        "tech": "OAuth2 REST · local whatsapp-mcp",
        "lines": ["Gmail OAuth2 + WhatsApp pairing", "tokens in the connector store"],
    },
}

AGENT_CHIPS = [
    (239, 718, 517, 30, "HTTP tool router", "one HttpTool subclass per route · server.ts"),
    (239, 756, 250, 50, "DurableHarness", "open on demand, pause when idle"),
    (505, 756, 251, 50, "ContainerAgent + model", "pi-durable 1.3.0 · SQLite storage"),
    (239, 814, 250, 50, "Citation gate · RFC 0006", "verifies every quote before publish"),
    (505, 814, 251, 50, "Tools: workspace, uploads, skills", "artifacts · corpus · traces"),
]


# ---------------------------------------------------------------- anchors
def anchor(node_id: str, side: str, t: float = 0.5) -> tuple[float, float]:
    n = NODES[node_id]
    x, y, w, h = n["x"], n["y"], n["w"], n["h"]
    if side == "left":
        return (x, y + h * t)
    if side == "right":
        return (x + w, y + h * t)
    if side == "top":
        return (x + w * t, y)
    if side == "bottom":
        return (x + w * t, y + h)
    raise ValueError(side)


STUB = {"left": (-16, 0), "right": (16, 0), "top": (0, -16), "bottom": (0, 16)}


def rounded_path(points: list[tuple[float, float]], radius: float = 9.0) -> str:
    d = [f"M {points[0][0]:.1f} {points[0][1]:.1f}"]
    for i in range(1, len(points) - 1):
        p0, p1, p2 = points[i - 1], points[i], points[i + 1]
        v1 = (p1[0] - p0[0], p1[1] - p0[1])
        v2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1 = math.hypot(*v1)
        l2 = math.hypot(*v2)
        if l1 < 0.01 or l2 < 0.01:
            continue
        rr = min(radius, l1 / 2, l2 / 2)
        a = (p1[0] - v1[0] / l1 * rr, p1[1] - v1[1] / l1 * rr)
        b = (p1[0] + v2[0] / l2 * rr, p1[1] + v2[1] / l2 * rr)
        d.append(f"L {a[0]:.1f} {a[1]:.1f}")
        d.append(f"Q {p1[0]:.1f} {p1[1]:.1f} {b[0]:.1f} {b[1]:.1f}")
    d.append(f"L {points[-1][0]:.1f} {points[-1][1]:.1f}")
    return " ".join(d)


# ---------------------------------------------------------------- edges
# from/to: (node, side, offset 0..1). via: absolute waypoints, in order.
# label: (pos, anchor, lines) drawn on a paper chip.
EDGES: list[dict] = [
    {
        "from": ("user", "right", 0.5),
        "to": ("web", "left", 0.54),
        "label": ((202, 222), "middle", ["HTTPS"]),
        "color": INK,
    },
    {
        "from": ("operator", "left", 0.5),
        "to": ("docker", "top", 0.49),
        "via": [(18, 679), (18, 98), (1210, 98)],
        "label": ((700, 91), "middle", ["docker compose up · build · reload"]),
        "color": TEAL,
    },
    {
        "from": ("web", "right", 0.54),
        "to": ("caddy", "left", 0.55),
        "label": ((510, 217), "middle", ["HTTP", "/u/<uid>/*"]),
        "color": RED,
        "two_line": True,
    },
    {
        "from": ("web", "bottom", 0.674),
        "to": ("manager", "left", 0.5),
        "via": [(390, 330), (530, 330), (530, 425)],
        "label": ((475, 323), "middle", ["POST /resolve"]),
        "color": INK,
    },
    {
        "from": ("caddy", "bottom", 0.5),
        "to": ("manager", "top", 0.5),
        "label": ((680, 320), "start", ["forward_auth"]),
        "color": INK,
    },
    {
        "from": ("manager", "right", 0.5),
        "to": ("oltp", "left", 0.5),
        "label": ((818, 417), "middle", ["SQL", "rw"]),
        "color": INK,
        "two_line": True,
        "bare": True,
    },
    {
        "from": ("web", "top", 0.51),
        "to": ("oltp", "top", 0.47),
        "via": [(350, 155), (925, 155)],
        "label": ((800, 147), "middle", ["Drizzle · auth, chats, traces"]),
        "color": INK,
    },
    {
        "from": ("caddy", "right", 0.42),
        "to": ("agent", "top", 0.87),
        "via": [(805, 220), (805, 575), (700, 575)],
        "label": ((815, 300), "start", ["reverse_proxy", "X-Sandbox-Endpoint"]),
        "color": RED,
        "two_line": True,
    },
    {
        "from": ("manager", "bottom", 0.3),
        "to": ("docker", "left", 0.5),
        "via": [(620, 544), (1040, 544), (1040, 435)],
        "label": ((880, 536), "start", ["docker create/start/stop"]),
        "color": TEAL,
    },
    {
        "from": ("agent", "right", 0.79),
        "to": ("openrouter", "left", 0.5),
        "via": [(1046, 890), (1046, 620)],
        "label": ((900, 882), "middle", ["HTTPS · completions"]),
        "color": BLUE,
    },
    {
        "from": ("agent", "bottom", 0.87),
        "to": ("connectors", "bottom", 0.49),
        "via": [(700, 952), (1210, 952)],
        "label": ((1220, 900), "start", ["OAuth2 · QR pair — draft"]),
        "color": MUTED_EDGE,
        "dash": "5 5",
    },
    {
        "from": ("agent", "right", 0.18),
        "to": ("vol_ws", "left", 0.42),
        "label": ((790, 634), "middle", ["rw"]),
        "color": MUTED_EDGE,
        "dash": "5 5",
        "both": True,
    },
    {
        "from": ("agent", "right", 0.66),
        "to": ("vol_data", "left", 0.46),
        "label": ((790, 784), "middle", ["rw"]),
        "color": MUTED_EDGE,
        "dash": "5 5",
        "both": True,
    },
]


def edge_points(edge: dict) -> list[tuple[float, float]]:
    src = anchor(*edge["from"])
    dst = anchor(*edge["to"])
    ss = STUB[edge["from"][1]]
    ds = STUB[edge["to"][1]]
    pts = [src, (src[0] + ss[0], src[1] + ss[1])]
    pts.extend(edge.get("via", []))
    pts.append((dst[0] + ds[0], dst[1] + ds[1]))
    pts.append(dst)
    return pts


# ---------------------------------------------------------------- node painters
def paint_person(n: dict) -> list[str]:
    out = [
        rect(n["x"], n["y"], n["w"], n["h"], AMBER_SOFT, INK),
        f'<circle cx="{n["x"] + 22:.1f}" cy="{n["y"] + 24:.1f}" r="6.2" fill="none" stroke="{INK}" stroke-width="1.4"/>',
        (
            f'<path d="M {n["x"] + 12:.1f} {n["y"] + 41:.1f} '
            f'Q {n["x"] + 22:.1f} {n["y"] + 30:.1f} {n["x"] + 32:.1f} {n["y"] + 41:.1f}" '
            f'fill="none" stroke="{INK}" stroke-width="1.4"/>'
        ),
        text(n["x"] + 44, n["y"] + 24, "PERSON", 7.5, INK_SOFT, mono=True, tracking=1.1),
        text(n["x"] + 12, n["y"] + 58, n["title"], 11.4, INK, bold=True),
        text(n["x"] + 12, n["y"] + 72, n["tech"], 8.6, INK_SOFT, mono=True),
    ]
    y = n["y"] + 92
    wrapped = fit(n["lines"], n["w"] - 24, 9.4)
    for line in wrapped:
        out.append(text(n["x"] + 12, y, line, 9.4, INK))
        y += 12.4
    require(y - 12.4 <= n["y"] + n["h"] - 8, f'person {n["title"]}: content overflows ({y:.1f})')
    return out


def paint_header(n: dict, tag: str, tag_color: str, fill: str, stroke: str, right_tag: str = "") -> list[str]:
    hh = 26
    out = [
        rect(n["x"], n["y"], n["w"], n["h"], fill, stroke),
        rect(n["x"], n["y"], n["w"], hh, PAPER_3, stroke),
        text(n["x"] + 12, n["y"] + 16.5, tag, 7.6, tag_color, mono=True, tracking=1.3),
    ]
    if right_tag:
        out.append(
            text(n["x"] + n["w"] - 12, n["y"] + 16.5, right_tag, 7.6, INK_SOFT, mono=True, anchor="end", tracking=1.1)
        )
    return out


def paint_container(n: dict) -> list[str]:
    out = paint_header(n, "CONTAINER", INK_SOFT, PAPER_2, INK)
    out.append(text(n["x"] + 12, n["y"] + 51, n["title"], 14.6, INK, bold=True))
    out.append(text(n["x"] + 12, n["y"] + 67, n["tech"], 8.8, INK_SOFT, mono=True))
    y = n["y"] + 84
    for line in fit(n["lines"], n["w"] - 24, 9.8):
        out.append(text(n["x"] + 12, y, line, 9.8, INK))
        y += 12.8
    require(y - 12.8 <= n["y"] + n["h"] - 8, f'container {n["title"]}: content overflows ({y:.1f})')
    return out


def paint_agent(n: dict) -> list[str]:
    out = paint_header(n, "CONTAINER", INK_SOFT, PAPER_2, INK, "ONE PER USER")
    out.append(text(n["x"] + 14, n["y"] + 57, n["title"], 16, INK, bold=True))
    out.append(text(n["x"] + n["w"] - 14, n["y"] + 57, "node 24", 8.8, INK_SOFT, mono=True, anchor="end"))
    out.append(text(n["x"] + 14, n["y"] + 75, n["tech"], 8.6, INK_SOFT, mono=True))
    y = n["y"] + 93
    for line in fit(n["lines"], n["w"] - 28, 9.8):
        out.append(text(n["x"] + 14, y, line, 9.8, INK))
        y += 12.4
    require(y - 12.4 <= 718 - 8, f"agent bullets collide with chips ({y:.1f})")

    for cx, cy, cw, ch, title, sub in AGENT_CHIPS:
        out.append(rect(cx, cy, cw, ch, PAPER, RULE, rx=2, sw=1.0))
        if ch >= 44:
            out.append(text(cx + 9, cy + 19, title, 9.7, INK, bold=True))
            out.append(text(cx + 9, cy + 33, sub, 8.4, INK_SOFT))
            require(tw(sub, 8.4) <= cw - 18, f"agent chip sub overflows: {sub}")
        else:
            out.append(text(cx + 9, cy + 19, title, 9.5, INK, bold=True))
            sub_x = cx + 9 + tw(title, 9.5, bold=True) + 12
            out.append(text(sub_x, cy + 19, sub, 8.4, INK_SOFT))
            require(sub_x + tw(sub, 8.4) <= cx + cw - 8, f"agent chip row overflows: {title}")
        require(tw(title, 9.7, bold=True) <= cw - 18, f"agent chip title overflows: {title}")
    out.append(
        text(
            n["x"] + 14,
            n["y"] + n["h"] - 16,
            "SESSION_DB=/data/session.sqlite · WORKSPACE=/workspace · IDLE_MS=5000",
            8.2,
            INK_SOFT,
            mono=True,
        )
    )
    return out


def paint_volume(n: dict) -> list[str]:
    out = paint_header(n, "VOLUME", TEAL, TEAL_SOFT, TEAL)
    out.append(text(n["x"] + 12, n["y"] + 51, n["title"], 12.4, INK, bold=True, mono=True))
    out.append(text(n["x"] + 12, n["y"] + 67, n["tech"], 8.4, INK_SOFT, mono=True))
    y = n["y"] + 85
    for line in fit(n["lines"], n["w"] - 24, 9.4):
        out.append(text(n["x"] + 12, y, line, 9.4, INK))
        y += 12.4
    require(y - 12.4 <= n["y"] + n["h"] - 8, f'volume {n["title"]}: content overflows ({y:.1f})')
    return out


def paint_external(n: dict, draft: bool = False) -> list[str]:
    stroke = BLUE
    out = paint_header(
        n,
        "EXTERNAL SYSTEM",
        BLUE,
        BLUE_SOFT if not draft else PAPER_2,
        stroke,
        "RFC 0010 · DRAFT" if draft else "",
    )
    if draft:
        out[0] = rect(n["x"], n["y"], n["w"], n["h"], PAPER_2, RED, dash="4 4")
        out.append(rect(n["x"], n["y"], n["w"], 26, PAPER_3, RED, dash="4 4"))
        out.append(text(n["x"] + n["w"] - 12, n["y"] + 16.5, "RFC 0010 · DRAFT", 7.6, RED, mono=True, anchor="end", tracking=1.1))
    out.append(text(n["x"] + 12, n["y"] + 51, n["title"], 13.4, INK, bold=True))
    out.append(text(n["x"] + 12, n["y"] + 67, n["tech"], 8.6, INK_SOFT, mono=True))
    y = n["y"] + 85
    for line in fit(n["lines"], n["w"] - 24, 9.8):
        out.append(text(n["x"] + 12, y, line, 9.8, INK))
        y += 12.8
    require(y - 12.8 <= n["y"] + n["h"] - 8, f'external {n["title"]}: content overflows ({y:.1f})')
    return out


# ---------------------------------------------------------------- boundaries
def boundary(x, y, w, h, label, note, color) -> list[str]:
    out = [
        rect(x, y, w, h, "none", color, rx=3, sw=1.2, dash="7 6"),
        text(x + 10, y + 16, label, 9.4, INK_SOFT, mono=True, tracking=1.2),
    ]
    if note:
        out.append(text(x + w - 10, y + 16, note, 8.8, INK_SOFT, mono=True, anchor="end"))
    return out


# ---------------------------------------------------------------- compose svg
def build_svg() -> str:
    colors = {
        INK: "ink",
        RED: "red",
        TEAL: "teal",
        BLUE: "blue",
        MUTED_EDGE: "muted",
    }
    defs = ["<defs>"]
    for color, name in colors.items():
        defs.append(
            f'<marker id="ar-{name}" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="6.5" '
            f'markerHeight="6.5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 Z" fill="{color}"/></marker>'
        )
    defs.append(
        f'<pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">'
        f'<path d="M28 0 H0 V28" fill="none" stroke="{RULE_SOFT}" stroke-width="0.7"/></pattern>'
    )
    defs.append("</defs>")

    body: list[str] = [f'<rect width="{W}" height="{H}" fill="{PAPER}"/>', f'<rect width="{W}" height="{H}" fill="url(#grid)"/>']

    # header
    body.append(text(40, 30, "AFFIDO · C4 MODEL", 8.6, INK_SOFT, mono=True, tracking=2.2))
    body.append(text(40, 64, "Container Diagram", 31, INK, bold=True))
    body.append(
        text(
            430,
            42,
            "One durable, sandboxed, fully traced agent per user: bounded by its container,",
            10.6,
            INK_SOFT,
        )
    )
    body.append(text(430, 56, "granted one skill at a time; resumed after pause or eviction.", 10.6, INK_SOFT))
    body.append(text(1360, 30, "C4 · CONTAINERS", 8.6, INK_SOFT, mono=True, anchor="end", tracking=2.2))

    # legend
    legend = [("control", INK, None), ("data plane", RED, None), ("provisioning", TEAL, None), ("model", BLUE, None), ("draft / volume", MUTED_EDGE, "4 4")]
    lx = 918.0
    for label, color, dash in legend:
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        body.append(
            f'<path d="M {lx:.1f} 78 H {lx + 18:.1f}" stroke="{color}" stroke-width="2"{dash_attr} fill="none"/>'
        )
        body.append(f'<circle cx="{lx + 9:.1f}" cy="78" r="2.2" fill="{color}"/>')
        body.append(text(lx + 23, 81, label, 8.4, INK_SOFT, mono=True))
        lx += 23 + tw(label, 8.4, mono=True) + 14

    # boundaries
    body.extend(
        boundary(
            205,
            120,
            820,
            405,
            "AFFIDO CONTROL PLANE — docker compose project",
            "",
            INK,
        )
    )
    body.extend(
        boundary(
            205,
            560,
            820,
            370,
            "PER-USER SANDBOX — one container, one network, own volumes",
            "no host ports · WORKSPACE + SESSION_DB",
            RED,
        )
    )

    # edges under nodes; labels come after the nodes so no chip is clipped
    label_svg: list[tuple[dict, str]] = []
    for edge in EDGES:
        pts = edge_points(edge)
        color = edge["color"]
        name = colors[color]
        dash_attr = f' stroke-dasharray="{edge["dash"]}"' if edge.get("dash") else ""
        start_marker = f' marker-start="url(#ar-{name})"' if edge.get("both") else ""
        body.append(
            f'<path d="{rounded_path(pts)}" fill="none" stroke="{color}" stroke-width="1.6"{dash_attr}'
            f' stroke-linejoin="round" marker-end="url(#ar-{name})"{start_marker}/>'
        )
        label_svg.append((edge, color))

    # nodes
    for node in NODES.values():
        kind = node["kind"]
        if kind == "person":
            body.extend(paint_person(node))
        elif kind == "container":
            body.extend(paint_container(node))
        elif kind == "agent":
            body.extend(paint_agent(node))
        elif kind == "volume":
            body.extend(paint_volume(node))
        elif kind == "external":
            body.extend(paint_external(node))
        elif kind == "draft":
            body.extend(paint_external(node, draft=True))

    # edge labels on top of nodes
    for edge, color in label_svg:
        (lx, ly), lanchor, lines = edge["label"]
        size = 9.0
        line_h = 10.6
        widths = [tw(line, size, mono=True) for line in lines]
        chip_w = max(widths) + 12
        chip_h = line_h * len(lines) + 6
        if lanchor == "middle":
            cx = lx - chip_w / 2
        elif lanchor == "end":
            cx = lx - chip_w
        else:
            cx = lx
        cy = ly - chip_h + 5
        if not edge.get("bare"):
            body.append(
                f'<rect x="{cx:.1f}" y="{cy:.1f}" width="{chip_w:.1f}" height="{chip_h:.1f}" rx="2" '
                f'fill="{PAPER}" stroke="{color}" stroke-opacity="0.35" stroke-width="0.8"/>'
            )
        for i, line in enumerate(lines):
            body.append(text(cx + 6, cy + 10.2 + i * line_h, line, size, color, mono=True))

    # footer
    body.append(
        text(
            40,
            968,
            "Sources: docker-compose.yml · caddy/Caddyfile · sandbox-manager/sandbox_manager.py · "
            "agent/server.ts · agent/harness.ts · frontend/src/lib/server/sandbox.ts",
            8.2,
            INK_SOFT,
            mono=True,
        )
    )
    body.append(
        text(1360, 968, "docs/diagrams/c4_containers.py", 8.2, INK_SOFT, mono=True, anchor="end")
    )

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
        f'role="img" aria-labelledby="c4title c4desc">'
        f'<title id="c4title">affido — C4 container diagram</title>'
        f'<desc id="c4desc">Actors, internal services, external services, volumes and connections of the '
        f'affido stack: web client, Caddy gateway, sandbox manager, OLTP Postgres, per-user agent '
        f'sandbox, Docker Engine, model API.</desc>'
        + "\n".join(defs)
        + "\n".join(body)
        + "\n</svg>"
    )


HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>affido — C4 container diagram</title>
<style>
  html, body {{ margin: 0; padding: 0; background: {paper}; }}
  svg {{ display: block; width: 100%; height: auto; }}
</style>
</head>
<body>
{svg}
</body>
</html>
"""


def main() -> None:
    svg = build_svg()
    OUT.write_text(HTML.format(paper=PAPER, svg=svg), encoding="utf-8")
    for warning in WARNINGS:
        print(f"WARN {warning}")
    print(f"wrote {OUT.relative_to(Path.cwd())} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
