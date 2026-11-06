#!/usr/bin/env python3
"""Generate docs/diagrams/c4-containers.html — affido C4 container diagram.

The diagram is one fixed SVG with a viewBox, so it scales with the page. Nodes
are declared with (x, y, w, h); edges are declared by node id plus anchor side
and offset, with optional absolute waypoints. The router turns each edge into
an orthogonal polyline and rounds the corners, so no path is drawn by hand.

The drawing is a snapshot of the running stack, not of an RFC: every box is a
file in this repository and every arrow is a call that exists in the code.
Draft/proposed RFCs with no code are listed in the ROADMAP box, never as containers.

Run: python3 docs/diagrams/c4_containers.py
"""

from __future__ import annotations

import html
import math
from pathlib import Path

from PIL import ImageFont

W, H = 1600, 1380
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
WEB = "#6f4b8a"
WEB_SOFT = "#eae0ef"
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

BULLET = 10.2
BULLET_STEP = 12.8
TECH = 9.0
TITLE = 14.8
TAG = 7.8
CHIP_TITLE = 9.8
CHIP_SUB = 8.6
CHIP_TOP = 738


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
# kind: person | container | agent | volume | external | draft
# container/external fields: tag, tag_color, fill, stroke, right_tag, right_color.
NODES: dict[str, dict] = {
    "user": {
        "kind": "person",
        "x": 30, "y": 155, "w": 150, "h": 150,
        "title": "User / Owner",
        "tech": "browser",
        "lines": ["chat · uploads · settings", "traces · judge audit", "Strict / Web toggles"],
    },
    "operator": {
        "kind": "person",
        "x": 30, "y": 700, "w": 150, "h": 150,
        "title": "Operator / Deployer",
        "tech": "shell · dev.sh",
        "lines": ["up · reload · reset", "verify.sh · e2e suites", "install runsc (gVisor)", "restore egress=off"],
    },
    "web": {
        "kind": "container",
        "x": 215, "y": 155, "w": 255, "h": 165,
        "title": "Web Client",
        "tech": "SvelteKit 3 · Svelte 5 · Drizzle",
        "lines": [
            "better-auth sign-in + sessions",
            "chat (AI SDK) · docs · corpus · skills",
            "traces: graph + Judge tab (on demand)",
            "settings: BYOK provider + key",
            "composer: Strict citations / Web",
        ],
        "tag": "APP",
        "right_tag": "outside compose",
    },
    "caddy": {
        "kind": "container",
        "x": 550, "y": 155, "w": 255, "h": 165,
        "title": "Caddy Gateway",
        "tech": "caddy:2.11.4-alpine · :18080",
        "lines": [
            "CADDY_BIND=127.0.0.1 (loopback)",
            "forward_auth → manager /resolve",
            "/providers/* → /whoami, then proxy",
            "strips client X-Sandbox-Endpoint",
            "reverse_proxy to per-user :8080",
            "/skills/file · /ingest · /uploads/*",
        ],
        "right_tag": "published :18080",
    },
    "oltp": {
        "kind": "container",
        "x": 845, "y": 155, "w": 240, "h": 165,
        "title": "OLTP Postgres",
        "tech": "postgres:17-alpine · oltp-data",
        "lines": [
            "better-auth user / session",
            "sandbox_registry",
            "provider_key (AES-GCM ciphertext)",
            "provider_selection",
            "documents · chats · trace_session",
            "127.0.0.1:15432 only",
        ],
    },
    "marketplace": {
        "kind": "container",
        "x": 215, "y": 375, "w": 255, "h": 160,
        "title": "Skills Marketplace",
        "tech": "marketplace/manifest.mjs · sha256",
        "lines": [
            "curated bundles, manifest hashed",
            "md-to-docx · pdf-text-extraction",
            "server-side fs read at request time",
            "bytes installed via Caddy, one file each",
            "verify.sh checks every hash",
        ],
        "tag": "HOST FILES",
        "tag_color": AMBER,
    },
    "manager": {
        "kind": "container",
        "x": 550, "y": 375, "w": 255, "h": 160,
        "title": "Sandbox Manager",
        "tech": "Python 3.13 · psycopg · docker CLI",
        "lines": [
            "registry · provisioning · eviction",
            "BYOK: AES-GCM keys + reconcile",
            "idle stop · watchdog · peer guard",
            "hostwall iptables · runsc boot gate",
            "resolve: /config · /webconfig · /control",
        ],
    },
    "kek": {
        "kind": "container",
        "x": 845, "y": 375, "w": 240, "h": 160,
        "title": "llm_key_kek",
        "tech": "secrets/ · ro mount into manager",
        "lines": [
            "32-byte KEK (raw or base64)",
            "AES-256-GCM, AAD=user||provider",
            "plaintext keys never at rest",
            "standalone agent: /run/secrets",
        ],
        "tag": "SECRET FILE",
        "tag_color": RED,
        "fill": RED_SOFT,
        "stroke": RED,
        "right_tag": "manager only",
        "right_color": RED,
    },
    "agent": {
        "kind": "agent",
        "x": 215, "y": 620, "w": 470, "h": 430,
        "title": "Agent Sandbox",
        "tech": "affido-agent:latest · node /app/server.ts · PORT=8080",
        "lines": [
            "Runs the conversation: /prompt in, cited answer + trace out.",
            "Faux keyless by default; real providers are BYOK via the sidecar.",
        ],
    },
    "sidecar": {
        "kind": "container",
        "x": 705, "y": 620, "w": 380, "h": 190,
        "title": "Key-injection Sidecar",
        "tech": "same image · node /app/sidecar.ts · :8081",
        "lines": [
            "holds apiKey in process RAM only",
            "POST /config {apiKey} at resolve time",
            "strips inbound auth, stamps the key",
            "pinned upstream; /judge/decisions",
            "no volumes · no published ports",
        ],
        "tag": "CONTAINER",
        "tag_color": BLUE,
        "fill": BLUE_SOFT,
        "stroke": BLUE,
        "right_tag": "RFC 0013 · no key in agent",
        "right_color": BLUE,
    },
    "websearch": {
        "kind": "container",
        "x": 705, "y": 830, "w": 380, "h": 220,
        "title": "Web-search Node",
        "tech": "same image · node /app/websearch.ts · :8082",
        "lines": [
            "POST /runs · /search · /read",
            "opaque sourceId; no URL argument",
            "4 searches · 8 results · 6000 chars",
            "per-run token + manager control token",
            "no volumes · no user code · no egress",
            "web: allowed per message (default off)",
        ],
        "tag": "CONTAINER",
        "tag_color": WEB,
        "fill": WEB_SOFT,
        "stroke": WEB,
        "right_tag": "RFC 0016",
        "right_color": WEB,
    },
    "vol_ws": {
        "kind": "volume",
        "x": 215, "y": 1070, "w": 470, "h": 145,
        "title": "pi-ws-<user>",
        "tech": "/workspace · docker volume",
        "lines": [
            "corpus/{raw,uploads,text,meta} (RFC 0014)",
            "skills/ · artifacts/ · workspace files",
            "PDF text derived at ingest (unpdf)",
        ],
    },
    "vol_data": {
        "kind": "volume",
        "x": 705, "y": 1070, "w": 380, "h": 145,
        "title": "pi-data-<user>",
        "tech": "/data/session.sqlite",
        "lines": [
            "conversations · entries · submissions",
            "citation runs + judge verdicts",
            "web.taint (durable, never cleared)",
            "survives pause, stop/restart, eviction",
        ],
    },
    "docker": {
        "kind": "external",
        "x": 1140, "y": 155, "w": 430, "h": 170,
        "title": "Docker Engine (host daemon)",
        "tech": "/var/run/docker.sock · runsc required",
        "lines": [
            "creates per-user networks + volumes",
            "starts/stops the three containers",
            "gVisor + --cap-drop ALL + seccomp",
        ],
    },
    "providers": {
        "kind": "external",
        "x": 1140, "y": 355, "w": 430, "h": 190,
        "title": "Model providers (BYOK)",
        "tech": "OpenRouter / OpenAI / custom · HTTPS",
        "lines": [
            "chat completions via sidecar proxy",
            "/judge/decisions → d1.1 classifier",
            "pinned upstream, key in sidecar RAM",
            "AGENT_EGRESS=open required for real keys",
        ],
    },
    "search": {
        "kind": "external",
        "x": 1140, "y": 595, "w": 430, "h": 230,
        "title": "SearXNG + Camofox (operator)",
        "tech": "websearch-in (internal) · websearch-out (egress)",
        "lines": [
            "only services with internet egress",
            "page fetch runs in Camofox's browser",
            "CAMOFOX_API_KEY: shared operator secret",
            "verify.sh uses an e2e-only fake stack",
        ],
        "tag": "EXTERNAL / OPERATOR",
        "tag_color": WEB,
        "fill": WEB_SOFT,
        "stroke": WEB,
    },
    "internet": {
        "kind": "external",
        "x": 1140, "y": 855, "w": 430, "h": 130,
        "title": "Open web",
        "tech": "HTTPS · no sandbox or node ever dials it",
        "lines": ["reached only through websearch-out"],
    },
    "future": {
        "kind": "draft",
        "x": 1140, "y": 1015, "w": 430, "h": 150,
        "title": "Not implemented (no code)",
        "tech": "draft / proposed RFCs, listed for completeness",
        "lines": [
            "RFC 0010 — Gmail / WhatsApp connectors",
            "RFC 0015 — multiple agents per user",
            "RFC 0019 — web-derived citations",
        ],
    },
}

# Absolute chips inside the agent box. (x, y, w, h, title, sub)
AGENT_CHIPS = [
    (229, 738, 442, 30, "HTTP tool router", "HttpTool per route (tools.ts) · /prompt idempotent by requestId"),
    (229, 778, 216, 52, "DurableHarness", "activate · pause · conversations"),
    (455, 778, 216, 52, "ContainerAgent + model", "pi-durable 1.3.0 · registry"),
    (229, 840, 216, 52, "Citation gate · RFC 0006", "verified quotes · strict runs"),
    (455, 840, 216, 52, "Coherence judge · d1.1", "RFC 0017/18/20 · audit trace"),
    (229, 902, 216, 52, "IngestPipeline · RFC 0014", "corpus/meta registry · unpdf"),
    (455, 902, 216, 52, "Web tools + taint gate", "web_search · web_read · 409"),
    (229, 964, 216, 52, "Skills + artifacts", "marketplace · /artifact"),
    (455, 964, 216, 52, "Traces + judge audit", "/inspect?report=citations"),
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
# label: (pos, anchor, lines) drawn on a paper chip; pos is near its baseline.
EDGES: list[dict] = [
    {
        "from": ("user", "right", 0.5),
        "to": ("web", "left", 0.54),
        "label": ((198, 218), "middle", ["HTTPS"]),
        "color": INK,
    },
    {
        "from": ("operator", "left", 0.5),
        "to": ("docker", "top", 0.5),
        "via": [(16, 775), (16, 100), (1355, 100)],
        "label": ((600, 100), "middle", ["dev.sh up · reload · verify.sh"]),
        "color": TEAL,
    },
    {
        "from": ("web", "right", 0.35),
        "to": ("caddy", "left", 0.35),
        "label": ((510, 205), "middle", ["HTTP /u/<uid>/*", "/providers/*"]),
        "color": RED,
    },
    {
        "from": ("web", "bottom", 0.32),
        "to": ("marketplace", "top", 0.32),
        "label": ((300, 355), "middle", ["server-side fs read", "manifest + bytes"]),
        "color": INK,
    },
    {
        "from": ("web", "bottom", 0.84),
        "to": ("manager", "left", 0.5),
        "via": [(430, 345), (525, 345), (525, 455)],
        "label": ((470, 340), "middle", ["POST /resolve (trusted mode)"]),
        "color": INK,
    },
    {
        "from": ("web", "top", 0.5),
        "to": ("oltp", "top", 0.5),
        "via": [(342.5, 142), (965, 142)],
        "stub": 0.0,
        "label": ((600, 148), "middle", ["Drizzle · auth, chats, traces"]),
        "color": INK,
    },
    {
        "from": ("caddy", "bottom", 0.5),
        "to": ("manager", "top", 0.5),
        "label": ((690, 365), "start", ["forward_auth /resolve", "/providers/* → /whoami"]),
        "color": INK,
    },
    {
        "from": ("manager", "top", 0.5),
        "to": ("oltp", "bottom", 0.5),
        "via": [(677.5, 347), (965, 347)],
        "label": ((830, 340), "middle", ["SQL rw"]),
        "color": INK,
    },
    {
        "from": ("manager", "right", 0.5),
        "to": ("kek", "left", 0.5),
        "label": ((825, 440), "middle", ["ro"]),
        "color": TEAL,
    },
    {
        "from": ("manager", "bottom", 0.5),
        "to": ("docker", "left", 0.85),
        "via": [(700, 551), (1110, 551), (1110, 299.5)],
        "label": ((1150, 340), "start", ["docker create/start/stop"]),
        "color": TEAL,
    },
    {
        "from": ("caddy", "right", 0.75),
        "to": ("agent", "top", 0.755),
        "via": [(825, 278.75), (825, 578), (570, 578)],
        "label": ((820, 586), "middle", ["reverse_proxy · X-Sandbox-Endpoint", "/skills/file · /ingest · /uploads/*"]),
        "color": RED,
    },
    {
        "from": ("manager", "bottom", 0.25),
        "to": ("agent", "top", 0.15),
        "via": [(613, 560), (286, 560)],
        "label": ((420, 586), "middle", ["resolve: /config · /webconfig · /control"]),
        "color": TEAL,
    },
    {
        "from": ("manager", "bottom", 0.72),
        "to": ("sidecar", "top", 0.35),
        "via": [(734, 570), (838, 570)],
        "color": TEAL,
    },
    {
        "from": ("manager", "bottom", 0.9),
        "to": ("websearch", "top", 0.5),
        "via": [(1115, 551), (1115, 818), (895, 818)],
        "color": TEAL,
    },
    {
        "from": ("agent", "right", 0.398),
        "to": ("sidecar", "left", 0.9),
        "stub": 0.0,
        "color": BLUE,
    },
    {
        "from": ("sidecar", "right", 0.5),
        "to": ("providers", "left", 0.85),
        "via": [(1120, 715), (1120, 516.5)],
        "label": ((1150, 578), "start", ["HTTPS · chat + /judge/decisions"]),
        "color": BLUE,
    },
    {
        "from": ("agent", "right", 0.948),
        "to": ("websearch", "left", 0.9),
        "stub": 0.0,
        "color": WEB,
    },
    {
        "from": ("websearch", "right", 0.5),
        "to": ("search", "left", 0.9),
        "via": [(1120, 940), (1120, 802)],
        "label": ((1150, 845), "start", ["SearXNG /search · Camofox /evaluate"]),
        "color": WEB,
    },
    {
        "from": ("search", "bottom", 0.5),
        "to": ("internet", "top", 0.5),
        "stub": 0.0,
        "label": ((1400, 845), "start", ["websearch-out"]),
        "color": WEB,
    },
    {
        "from": ("agent", "bottom", 0.27),
        "to": ("vol_ws", "top", 0.27),
        "stub": 0.0,
        "label": ((360, 1065), "middle", ["rw"]),
        "color": MUTED_EDGE,
        "dash": "5 5",
        "both": True,
    },
    {
        "from": ("agent", "bottom", 0.86),
        "to": ("vol_data", "top", 0.5),
        "via": [(619, 1060), (895, 1060)],
        "stub": 0.0,
        "label": ((760, 1065), "middle", ["rw"]),
        "color": MUTED_EDGE,
        "dash": "5 5",
        "both": True,
    },
]


def edge_points(edge: dict) -> list[tuple[float, float]]:
    src = anchor(*edge["from"])
    dst = anchor(*edge["to"])
    scale = edge.get("stub", 1.0)
    ss = tuple(component * scale for component in STUB[edge["from"][1]])
    ds = tuple(component * scale for component in STUB[edge["to"][1]])
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
        text(n["x"] + 44, n["y"] + 24, "PERSON", TAG, INK_SOFT, mono=True, tracking=1.1),
        text(n["x"] + 12, n["y"] + 58, n["title"], 11.6, INK, bold=True),
        text(n["x"] + 12, n["y"] + 72, n["tech"], 8.8, INK_SOFT, mono=True),
    ]
    y = n["y"] + 92
    for line in fit(n["lines"], n["w"] - 24, 9.6):
        out.append(text(n["x"] + 12, y, line, 9.6, INK))
        y += 12.4
    require(y - 12.4 <= n["y"] + n["h"] - 8, f'person {n["title"]}: content overflows ({y:.1f})')
    return out


def paint_header(n: dict, tag: str, tag_color: str, fill: str, stroke: str) -> list[str]:
    hh = 26
    out = [
        rect(n["x"], n["y"], n["w"], n["h"], fill, stroke),
        rect(n["x"], n["y"], n["w"], hh, PAPER_3, stroke),
        text(n["x"] + 12, n["y"] + 16.5, tag, TAG, tag_color, mono=True, tracking=1.3),
    ]
    right_tag = n.get("right_tag", "")
    if right_tag:
        out.append(
            text(
                n["x"] + n["w"] - 12, n["y"] + 16.5, right_tag, TAG,
                n.get("right_color", INK_SOFT), mono=True, anchor="end", tracking=1.0,
            )
        )
        require(
            tw(tag, TAG, mono=True) + 24 + tw(right_tag, TAG, mono=True) + 12 <= n["w"],
            f'{n["title"]}: header tags collide',
        )
    return out


def paint_box(n: dict, *, start: int = 84, step: float = BULLET_STEP, size: float = BULLET) -> list[str]:
    out = paint_header(
        n,
        n.get("tag", "CONTAINER"),
        n.get("tag_color", INK_SOFT),
        n.get("fill", PAPER_2),
        n.get("stroke", INK),
    )
    out.append(text(n["x"] + 12, n["y"] + 51, n["title"], TITLE, INK, bold=True))
    out.append(text(n["x"] + 12, n["y"] + 67, n["tech"], TECH, INK_SOFT, mono=True))
    require(tw(n["tech"], TECH, mono=True) <= n["w"] - 24, f'{n["title"]}: tech line overflows')
    require(tw(n["title"], TITLE, bold=True) <= n["w"] - 24, f'{n["title"]}: title overflows')
    y = n["y"] + start
    for line in fit(n["lines"], n["w"] - 24, size):
        out.append(text(n["x"] + 12, y, line, size, INK))
        y += step
    require(y - step <= n["y"] + n["h"] - 8, f'{n["title"]}: content overflows ({y:.1f})')
    return out


def paint_container(n: dict) -> list[str]:
    return paint_box(n)


def paint_agent(n: dict) -> list[str]:
    out = paint_header(n, "CONTAINER", INK_SOFT, PAPER_2, INK)
    out.append(text(n["x"] + 14, n["y"] + 57, n["title"], 16.2, INK, bold=True))
    out.append(text(n["x"] + n["w"] - 14, n["y"] + 57, "node 24 · :8080", 8.8, INK_SOFT, mono=True, anchor="end"))
    out.append(text(n["x"] + 14, n["y"] + 75, n["tech"], 8.6, INK_SOFT, mono=True))
    y = n["y"] + 93
    for line in fit(n["lines"], n["w"] - 28, BULLET):
        out.append(text(n["x"] + 14, y, line, BULLET, INK))
        y += 12.4
    require(y - 12.4 <= CHIP_TOP - 8, f"agent bullets collide with chips ({y:.1f})")

    for cx, cy, cw, ch, title, sub in AGENT_CHIPS:
        out.append(rect(cx, cy, cw, ch, PAPER, RULE, rx=2, sw=1.0))
        if ch >= 44:
            out.append(text(cx + 9, cy + 19, title, CHIP_TITLE, INK, bold=True))
            out.append(text(cx + 9, cy + 33, sub, CHIP_SUB, INK_SOFT))
            require(tw(sub, CHIP_SUB) <= cw - 18, f"agent chip sub overflows: {sub}")
        else:
            out.append(text(cx + 9, cy + 19, title, 9.6, INK, bold=True))
            sub_x = cx + 9 + tw(title, 9.6, bold=True) + 12
            out.append(text(sub_x, cy + 19, sub, CHIP_SUB, INK_SOFT))
            require(sub_x + tw(sub, CHIP_SUB) <= cx + cw - 8, f"agent chip row overflows: {title}")
        require(tw(title, CHIP_TITLE, bold=True) <= cw - 18, f"agent chip title overflows: {title}")

    footer = "SESSION_DB=/data/session.sqlite · WORKSPACE=/workspace · IDLE_MS=5000"
    require(tw(footer, 8.4, mono=True) <= n["w"] - 28, "agent footer overflows")
    out.append(text(n["x"] + 14, n["y"] + n["h"] - 16, footer, 8.4, INK_SOFT, mono=True))
    return out


def paint_volume(n: dict) -> list[str]:
    out = paint_header(n, "VOLUME", TEAL, TEAL_SOFT, TEAL)
    out.append(text(n["x"] + 12, n["y"] + 51, n["title"], 12.6, INK, bold=True, mono=True))
    out.append(text(n["x"] + 12, n["y"] + 67, n["tech"], 8.6, INK_SOFT, mono=True))
    y = n["y"] + 85
    for line in fit(n["lines"], n["w"] - 24, 9.6):
        out.append(text(n["x"] + 12, y, line, 9.6, INK))
        y += 12.4
    require(y - 12.4 <= n["y"] + n["h"] - 8, f'volume {n["title"]}: content overflows ({y:.1f})')
    return out


def paint_external(n: dict) -> list[str]:
    n = {**n, "tag": n.get("tag", "EXTERNAL SYSTEM"), "tag_color": n.get("tag_color", BLUE),
         "fill": n.get("fill", BLUE_SOFT), "stroke": n.get("stroke", BLUE)}
    return paint_box(n, start=85)


def paint_draft(n: dict) -> list[str]:
    out = [
        rect(n["x"], n["y"], n["w"], n["h"], PAPER_2, RED, dash="4 4"),
        rect(n["x"], n["y"], n["w"], 26, PAPER_3, RED, dash="4 4"),
        text(n["x"] + 12, n["y"] + 16.5, "ROADMAP · NO CODE", TAG, RED, mono=True, tracking=1.2),
        text(n["x"] + 12, n["y"] + 51, n["title"], TITLE, INK, bold=True),
        text(n["x"] + 12, n["y"] + 67, n["tech"], TECH, INK_SOFT, mono=True),
    ]
    y = n["y"] + 85
    for line in fit(n["lines"], n["w"] - 24, BULLET):
        out.append(text(n["x"] + 12, y, line, BULLET, INK))
        y += BULLET_STEP
    require(y - BULLET_STEP <= n["y"] + n["h"] - 8, f'roadmap box overflows ({y:.1f})')
    return out


# ---------------------------------------------------------------- boundaries
def boundary(x, y, w, h, label, note, color) -> list[str]:
    """A dashed boundary whose caption sits on an opaque chip: arrows pass
    behind the caption instead of striking through the letters."""
    tracking = 0.6
    label_w = tw(label, 9.2, mono=True) + len(label) * tracking + 12
    note_w = tw(note, 8.6, mono=True) + len(note) * tracking + 12 if note else 0
    out = [rect(x, y, w, h, "none", color, rx=3, sw=1.2, dash="7 6")]
    out.append(f'<rect x="{x + 7:.1f}" y="{y + 2:.1f}" width="{label_w:.1f}" height="18" fill="{PAPER}"/>')
    out.append(text(x + 13, y + 16, label, 9.2, INK_SOFT, mono=True, tracking=tracking))
    if note:
        out.append(
            f'<rect x="{x + w - 10 - note_w:.1f}" y="{y + 2:.1f}" width="{note_w:.1f}" height="18" fill="{PAPER}"/>'
        )
        out.append(text(x + w - 16, y + 16, note, 8.6, INK_SOFT, mono=True, anchor="end", tracking=tracking))
    require(label_w + note_w + 34 <= w, f"boundary labels collide: {label}")
    return out


# ---------------------------------------------------------------- compose svg
def build_svg() -> str:
    colors = {
        INK: "ink",
        RED: "red",
        TEAL: "teal",
        BLUE: "blue",
        WEB: "web",
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
    body.append(text(40, 30, "AFFIDO · C4 MODEL", 8.8, INK_SOFT, mono=True, tracking=2.2))
    body.append(text(40, 64, "Container Diagram", 31, INK, bold=True))
    body.append(text(430, 42, "One durable, fully traced agent sandbox per user: three containers, two volumes,", 10.6, INK_SOFT))
    body.append(text(430, 56, "internal networks, and a per-run web path that never gives the model a URL.", 10.6, INK_SOFT))
    body.append(text(1560, 30, "C4 · CONTAINERS", 8.8, INK_SOFT, mono=True, anchor="end", tracking=2.2))
    body.append(text(1560, 56, "scope: CHANGELOG [Unreleased] + 0.1.0", 8.4, INK_SOFT, mono=True, anchor="end"))

    # legend
    legend = [
        ("control", INK, None),
        ("data plane", RED, None),
        ("provisioning", TEAL, None),
        ("model / key", BLUE, None),
        ("web plane", WEB, None),
        ("volume / draft", MUTED_EDGE, "4 4"),
    ]
    lx = 900.0
    for label, color, dash in legend:
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        body.append(
            f'<path d="M {lx:.1f} 78 H {lx + 18:.1f}" stroke="{color}" stroke-width="2"{dash_attr} fill="none"/>'
        )
        body.append(f'<circle cx="{lx + 9:.1f}" cy="78" r="2.2" fill="{color}"/>')
        body.append(text(lx + 23, 81, label, 8.4, INK_SOFT, mono=True))
        lx += 23 + tw(label, 8.4, mono=True) + 14
    require(lx - 14 <= W - 40, f"legend overflows ({lx:.1f})")

    # edges go under the boundaries and the nodes; labels come last so no
    # chip is clipped and boundary captions hide any arrow crossing them.
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

    # boundaries on top of the edges, under the nodes
    body.extend(
        boundary(
            200, 115, 900, 450,
            "AFFIDO CONTROL PLANE",
            "compose: caddy · oltp · sandbox-manager",
            INK,
        )
    )
    body.extend(
        boundary(
            200, 595, 900, 640,
            "PER-USER SANDBOX — agent + key sidecar + web-search node · no host ports · runsc · cap-drop ALL",
            "",
            RED,
        )
    )

    # nodes
    painters = {
        "person": paint_person,
        "container": paint_container,
        "agent": paint_agent,
        "volume": paint_volume,
        "external": paint_external,
        "draft": paint_draft,
    }
    for node in NODES.values():
        body.extend(painters[node["kind"]](node))

    # edge labels on top of nodes
    for edge, color in label_svg:
        if "label" not in edge:
            continue
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
        body.append(
            f'<rect x="{cx:.1f}" y="{cy:.1f}" width="{chip_w:.1f}" height="{chip_h:.1f}" rx="2" '
            f'fill="{PAPER}" stroke="{color}" stroke-opacity="0.35" stroke-width="0.8"/>'
        )
        for i, line in enumerate(lines):
            body.append(text(cx + 6, cy + 10.2 + i * line_h, line, size, color, mono=True))

    # notes: security and the two state-changing flows
    notes = [
        (1252, "SECURITY BOUNDARY", [
            "runsc mandatory (manager fails closed) · --cap-drop ALL · seccomp no-ptrace · --internal per-user networks + iptables INPUT DROP · peer guard 403",
            "websearch-in is internal; websearch-out is the only egress · the web-search node holds no volume and no user code · MANAGER_TOKEN-derived control tokens",
            "MANAGER_TOKEN random + fail-closed · CADDY_BIND=127.0.0.1 · Postgres on 127.0.0.1:15432 · no API key in env, image, volume or logs",
        ]),
        (1300, "KEY / WEB FLOWS", [
            "BYOK: PUT /providers/config → AES-GCM in OLTP (KEK) → decrypt at resolve → sidecar RAM → pinned HTTPS upstream; the agent holds a placeholder.",
            "WEB: web:\"allowed\" → /webconfig + /control → /runs token → /search /read → durable web.taint → 409 web_tainted for ingest, uploads, skills.",
        ]),
    ]
    for y, label, lines in notes:
        body.append(text(40, y, label, 8.8, INK_SOFT, mono=True, tracking=1.4))
        for i, line in enumerate(lines):
            require(tw(line, 8.4, mono=True) <= W - 80, f"footer note overflows: {line[:40]}")
            body.append(text(40, y + 13 + i * 11.4, line, 8.4, INK_SOFT, mono=True))

    body.append(
        text(
            40, 1338,
            "Host-owned: the SvelteKit web client (pnpm dev or optional WEB_CONTAINER), marketplace/ bundles and secrets/llm_key_kek. "
            "Compose declares only caddy, oltp and sandbox-manager; the manager creates all three sandbox containers.",
            8.2, INK_SOFT, mono=True,
        )
    )
    body.append(
        text(
            40, 1350,
            "Sources: docker-compose.yml · caddy/Caddyfile · sandbox-manager/sandbox_manager.py · agent/{server,tools,agent,ingest,sidecar,websearch}.ts ·",
            8.2, INK_SOFT, mono=True,
        )
    )
    body.append(text(40, 1362, "frontend/src · marketplace/ · e2e-test/ · CHANGELOG.md [Unreleased]", 8.2, INK_SOFT, mono=True))
    body.append(text(1560, 1362, "docs/diagrams/c4_containers.py · generated SVG", 8.2, INK_SOFT, mono=True, anchor="end"))

    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
        f'role="img" aria-labelledby="c4title c4desc">'
        f'<title id="c4title">affido — C4 container diagram</title>'
        f'<desc id="c4desc">Current affido stack: user and operator, SvelteKit web client, Caddy gateway, '
        f'sandbox manager, OLTP Postgres, BYOK key-encryption file and skills marketplace; one per-user group '
        f'of agent, key-injection sidecar and web-search node with two durable volumes; Docker Engine, model '
        f'providers, the operator SearXNG/Camofox search stack and the open web, with the labelled control, '
        f'data, provisioning, model and web connections between them.</desc>'
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
