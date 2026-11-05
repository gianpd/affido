#!/usr/bin/env python3
"""Score one stored run against gold.json and write metrics.json + REPORT.md.

Every number in the report is computed from runs/<run-id>/ artifacts. No live
service is contacted here: re-scoring an old run is deterministic.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import statistics
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
RUNS = HERE / "runs"


def collapse(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().lower()


def normalize(value: str | None) -> str:
    if not value:
        return ""
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        return (parsed.scheme + "://" + host + parsed.path.rstrip("/")).lower()
    except ValueError:
        return value.lower()


def domain(value: str | None) -> str:
    if not value:
        return ""
    try:
        return (urlsplit(value).hostname or "").lower()
    except ValueError:
        return ""


def suffix_match(host: str, candidate: str) -> bool:
    return host == candidate or host.endswith("." + candidate)


def relevant(result: dict, rubric: dict) -> bool:
    # /search exposes domain, title and snippet, never the URL.
    url = str(result.get("url") or "")
    text = collapse(" ".join(str(result.get(field) or "") for field in ("title", "snippet", "domain", "url")))
    host = str(result.get("domain") or "").lower() or domain(url)
    if any(pattern.lower() in text for pattern in rubric.get("exclude_url_regex", [])):
        return False
    if any(suffix_match(host, excluded.lower()) for excluded in rubric.get("exclude_domains", [])):
        return False
    if any(suffix_match(host, allowed.lower()) for allowed in rubric.get("domains", [])):
        return True
    hits = sum(1 for term in rubric.get("topical_terms", []) if collapse(term) in text)
    return hits >= 2


def p(values: list[float], percentile: int) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((percentile / 100) * (len(ordered) - 1)))
    return ordered[index]


def mean(values: list[float]) -> float:
    return round(statistics.fmean(values), 4) if values else 0.0


MARKDOWN_PATTERNS = [
    re.compile(r"^\s{0,3}#{1,6}\s", re.M),          # ATX heading
    re.compile(r"\]\([^)]+\)"),                       # markdown link
    re.compile(r"^\s*```", re.M),                     # fenced code
    re.compile(r"^\s*\|.*\|\s*$", re.M),              # table row
    re.compile(r"^\s*[-*]\s+\S", re.M),               # bullet
]

NOISE_WORDS = 8


def quality_of(text: str) -> dict:
    lines = text.splitlines()
    total = len(text) or 1
    prose = sum(len(line) for line in lines if len(line.split()) >= NOISE_WORDS)
    signals = sum(len(pattern.findall(text)) for pattern in MARKDOWN_PATTERNS)
    return {
        "prose_ratio": round(prose / total, 4),
        "markdown_signals": signals,
        "markdown_preserved": signals >= 2,
    }


def load(run_dir: Path) -> tuple[dict, dict, list[dict], dict, dict, dict, dict]:
    gold = json.loads((HERE / "gold.json").read_text())
    manifest = json.loads((run_dir / "manifest.json").read_text())
    attempts = [json.loads(line) for line in (run_dir / "attempts.jsonl").read_text().splitlines() if line.strip()]
    connectivity = json.loads((run_dir / "connectivity.json").read_text())
    references = json.loads((run_dir / "references" / "meta.json").read_text())
    smoke = json.loads((run_dir / "prompt-smoke.json").read_text())
    return gold, manifest, attempts, connectivity, references, smoke, {}


def raw_text(run_dir: Path, attempt: dict) -> str:
    primary = attempt.get("read")
    if not isinstance(primary, dict):
        return ""
    raw = json.loads((run_dir / attempt["raw_path"]).read_text())
    reads = raw.get("reads") if isinstance(raw.get("reads"), list) else []
    entry = reads[primary["index"]] if primary["index"] < len(reads) else None
    response = entry.get("response") if isinstance(entry, dict) else None
    body = response.get("body") if isinstance(response, dict) else None
    page = body.get("page") if isinstance(body, dict) and isinstance(body.get("page"), dict) else body
    if isinstance(page, dict) and isinstance(page.get("text"), str):
        return page["text"]
    return ""


def score_url_attempts(gold: dict, attempts: list[dict], refs: dict, run_dir: Path) -> list[dict]:
    urls = {item["id"]: item for item in gold["urls"]}
    scored = []
    for attempt in attempts:
        if attempt["kind"] != "url":
            continue
        item = urls[attempt["urlId"]]
        read = attempt["read"] or {}
        text = raw_text(run_dir, attempt)
        collapsed = collapse(text)
        head = item["head_markers"]
        deep = item["deep_markers"]
        head_hits = [m for m in head if collapse(m) in collapsed]
        deep_hits = [m for m in deep if collapse(m) in collapsed]
        markers = head + deep
        fidelity = len(head_hits + deep_hits) / len(markers) if markers else 0.0
        ceiling_chars = refs["urls"][item["id"]]["ceiling"]["chars"]
        completeness = min(1.0, len(text) / ceiling_chars) if ceiling_chars else 0.0
        envelope_ok = bool(
            read.get("status") == 200
            and read.get("untrusted") is True
            and read.get("reported_sha256") == read.get("text_sha256")
            and (read.get("text_chars") or 0) <= 6000
            and normalize(read.get("url")) == normalize(item["url"])
            and bool(read.get("title"))
            and isinstance(read.get("truncated"), bool)
            and isinstance(read.get("totalChars"), int)
        )
        quality = quality_of(text)
        window = read.get("window") if isinstance(read.get("window"), dict) else {}
        score = (
            0.40 * fidelity
            + 0.25 * completeness
            + 0.15 * quality["prose_ratio"]
            + 0.20 * (1.0 if envelope_ok else 0.0)
        )
        scored.append({
            "id": attempt["id"],
            "urlId": item["id"],
            "repetition": attempt["repetition"],
            "query": attempt["query"],
            "goldReached": attempt["goldReached"],
            "matchedUrl": attempt["matchedUrl"],
            "searchStatus": attempt["search"]["status"],
            "resultCount": attempt["search"]["count"],
            "readStatus": read.get("status"),
            "readOk": read.get("status") == 200 and (read.get("text_chars") or 0) > 0,
            "textChars": len(text),
            "envelopeOk": envelope_ok,
            "truncated": bool(read.get("truncated")),
            "totalChars": read.get("totalChars"),
            "windowMode": window.get("mode"),
            "headFidelity": len(head_hits) / len(head) if head else 0.0,
            "deepFidelity": len(deep_hits) / len(deep) if deep else None,
            "fidelity": fidelity,
            "completeness": completeness,
            "proseRatio": quality["prose_ratio"],
            "markdownSignals": quality["markdown_signals"],
            "markdownPreserved": quality["markdown_preserved"],
            "qualityScore": round(score, 4),
            "usable": read.get("status") == 200 and envelope_ok and fidelity >= 0.60 and score >= 0.70,
            "missingMarkers": [m for m in markers if m not in head_hits + deep_hits],
            "sha256": hashlib.sha256(text.encode()).hexdigest() if text else None,
        })
    return scored


def score_query_attempts(gold: dict, attempts: list[dict]) -> list[dict]:
    queries = {item["id"]: item for item in gold["queries"]}
    scored = []
    for attempt in attempts:
        if attempt["kind"] != "query":
            continue
        rubric = queries[attempt["queryId"]]["relevance"]
        results = attempt["results"][:8]
        judgments = [relevant(result, rubric) for result in results]
        top5 = judgments[:5]
        first = next((index + 1 for index, value in enumerate(judgments) if value), None)
        scored.append({
            "id": attempt["id"],
            "queryId": attempt["queryId"],
            "repetition": attempt["repetition"],
            "query": attempt["query"],
            "served": attempt["search"]["status"] == 200 and attempt["search"]["count"] > 0,
            "status": attempt["search"]["status"],
            "ms": attempt["search"]["ms"],
            "resultCount": attempt["search"]["count"],
            "relevant": sum(judgments),
            "precision5": sum(top5) / len(top5) if top5 else 0.0,
            "precision8": sum(judgments) / len(judgments) if judgments else 0.0,
            "top1Relevant": bool(judgments[0]) if judgments else False,
            "anyRelevant": any(judgments),
            "firstRelevantRank": first,
            "reciprocalRank": 1.0 / first if first else 0.0,
            "judgments": judgments,
            "urls": [result.get("url") for result in results],
        })
    return scored


def reachability(conn: dict, manifest: dict) -> list[dict]:
    host = conn["host"]
    agent = next((entry for entry in conn["agent"]["probe"] if entry.get("type") == "connectivity"), {})
    node = next((entry for entry in conn["node"]["probe"] if entry.get("type") == "upstream"), {})
    ac = agent.get("checks", {})
    nc = node.get("checks", {})
    tab = host.get("camofox_tab_probe", {"open_status": 0, "evaluate_status": 0, "close_status": 0, "ms": 0})
    rows = [
        {"edge": "host -> SearXNG published :8080", "observed": f"HTTP {host['searxng_published']['status']}, {host['searxng_published'].get('results', '?')} results, {host['searxng_published']['ms']} ms", "expected": "200 with results", "verdict": "reachable" if host["searxng_published"]["status"] == 200 else "DOWN"},
        {"edge": "host -> Camofox published :9377", "observed": f"HTTP {host['camofox_published']['status']}, {host['camofox_published']['ms']} ms", "expected": "200", "verdict": "reachable" if host["camofox_published"]["status"] == 200 else "DOWN"},
        {"edge": "web-search node -> SearXNG /search", "observed": f"HTTP {nc.get('searxng_search', {}).get('status')}, {node.get('searxng_result_count')} results, {nc.get('searxng_search', {}).get('ms')} ms", "expected": "200 with results", "verdict": "reachable" if nc.get("searxng_search", {}).get("status") == 200 else "DOWN"},
        {"edge": "web-search node -> Camofox /health", "observed": f"HTTP {nc.get('camofox_health', {}).get('status')}, {nc.get('camofox_health', {}).get('ms')} ms", "expected": "200", "verdict": "reachable" if nc.get("camofox_health", {}).get("status") == 200 else "DOWN"},
        {"edge": "host -> Camofox functional tab (open/evaluate/close)", "observed": f"open={tab['open_status']}, evaluate={tab['evaluate_status']}, close={tab['close_status']}, {tab['ms']} ms", "expected": "200/200/200", "verdict": "reachable" if tab["evaluate_status"] == 200 else "DEGRADED"},
        {"edge": "agent container -> web-search node :8082", "observed": f"TCP {'ok' if ac.get('node_tcp', {}).get('ok') else 'blocked'}, /health HTTP {ac.get('node_health', {}).get('status')}, /status HTTP {ac.get('node_status', {}).get('status')}", "expected": "TCP ok, HTTP 200", "verdict": "reachable" if ac.get("node_tcp", {}).get("ok") and ac.get("node_health", {}).get("status") == 200 else "DOWN"},
    ]
    for name in ("searxng", "camofox"):
        tcp = ac.get(f"tcp_{name}", {})
        http = ac.get(f"http_{name}", {})
        dns = ac.get(f"dns_{name}", {})
        isolated = not tcp.get("ok", False) and http.get("status", 0) == 0
        rows.append({
            "edge": f"agent container -> {name} DIRECT (negative control)",
            "observed": f"TCP {tcp.get('ok', '?')} ({tcp.get('error', 'ok')}), HTTP {http.get('status', 0)} ({http.get('error', 'ok')}), DNS {dns.get('ok', '?')}",
            "expected": "blocked: RFC 0016 gives egress only to the node",
            "verdict": "isolated" if isolated else "DIRECT LEAK",
        })
    rows.append({
        "edge": "topology",
        "observed": f"websearch-in internal={host['websearch_in']['internal']}; websearch-out internal={host['websearch_out']['internal']}; AGENT_EGRESS={manifest['host_env_AGENT_EGRESS']}",
        "expected": "websearch-in internal=true, node never on websearch-out",
        "verdict": "as designed" if host["websearch_in"]["internal"] == "true" else "MISCONFIGURED",
    })
    return rows


def table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join(["---"] * len(headers)) + " |"]
    for row in rows:
        out.append("| " + " | ".join(str(cell).replace("|", "\\|").replace("\n", " ") for cell in row) + " |")
    return "\n".join(out)


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def report(run_id: str, gold: dict, manifest: dict, conn: dict, refs: dict, smoke: dict, query_scores: list[dict], url_scores: list[dict], attempts: list[dict], metrics: dict) -> str:
    reach = reachability(conn, manifest)
    lines: list[str] = []
    lines.append(f"# Web-search evaluation — `{run_id}`")
    lines.append("")
    lines.append(f"Measured {manifest['started_at']} → {manifest['finished_at']}. "
                 f"Gold `gold.json` sha256 `{manifest['gold_sha256'][:16]}…`, git `{manifest['git_sha'][:10]}`, "
                 f"agent image `{manifest['agent_image'][:19]}…`, Node `{manifest['agent_node_version']}`, "
                 f"Camofox `{conn['host']['camofox_version']}`, Docker `{manifest['docker_version']}`.")
    lines.append(f"{manifest['repeats']} repetitions × 5 queries + {manifest['repeats']} × 5 URLs = "
                 f"{manifest['counts']['cases']['expected']} scored cases ({manifest['counts']['cases']['observed']} observed). "
                 f"Every scored call was issued from inside `{manifest['agent_container']}` with the exact headers of `postNode()`.")
    lines.append("")
    lines.append("## 1. Real-time reachability")
    lines.append("")
    lines.append(table(["Edge", "Observed", "Expected", "Verdict"], [[r["edge"], r["observed"], r["expected"], r["verdict"]] for r in reach]))
    lines.append("")
    engines = conn["host"]["searxng_published"].get("unresponsive_engines", [])
    lines.append(f"SearXNG engine health at measurement time: {json.dumps(engines, ensure_ascii=False) if engines else 'no suspended engines reported'}. "
                 "`agent/websearch.ts` cascades from the default engine set to single engines when it gets an empty 200, so a suspended default engine does not necessarily mean `no results`.")
    lines.append("")
    published = conn["host"]["searxng_published"]
    suspended = published.get("unresponsive_engines", [])
    lines.append(f"Service state: at measurement time the published SearXNG endpoint answered with {published.get('results', '?')} results and reported "
                 f"{len(suspended)} suspended/unresponsive engines. `agent/websearch.ts` falls back to single engines on an empty 200, so a partially suspended engine set "
                 f"does not by itself mean `no results`. An earlier discovery pass saw the default set return empty 200s and Camofox log a tab-create timeout plus "
                 f"an automatic browser relaunch; that evidence is kept in `runs/{run_id}/discovery-degraded-1009.json` and `runs/{run_id}/pre-gold/` when present.")
    lines.append("")
    lines.append("The agent container cannot name or dial a page: `web_read` takes only an opaque `sourceId`, and `/search` returns no URL at all. "
                 "The direct TCP/HTTP/DNS checks are negative controls — they must fail, or the RFC 0016 isolation claim is broken. "
                 "The end-to-end proof that the stack actually works is the search/read hit rate below, plus the `/prompt` smoke.")
    lines.append("")
    lines.append("## 2. Hit rate")
    lines.append("")
    hit_rows = []
    for query in gold["queries"]:
        rows = [q for q in query_scores if q["queryId"] == query["id"]]
        served = sum(1 for q in rows if q["served"])
        lat = [q["ms"] for q in rows if isinstance(q["ms"], (int, float))]
        hit_rows.append([query["id"], query["query"][:52], f"{served}/{len(rows)}", pct(served / len(rows)), f"{int(p(lat, 50) or 0)} ms", f"{int(p(lat, 90) or 0)} ms"])
    lines.append(table(["Query", "Text", "Served", "Rate", "p50", "p90"], hit_rows))
    lines.append("")
    lines.append(f"- **search_hit_rate = {pct(metrics['search_hit_rate'])}** ({metrics['served_searches']}/{len(attempts)} search attempts). "
                 f"A search is *served* when HTTP 200 returns at least one result.")
    lines.append(f"- **read_hit_rate = {pct(metrics['read_hit_rate'])}** ({metrics['ok_reads']}/{metrics['read_attempts']} read attempts). "
                 f"A read is a hit when HTTP 200 returns non-empty text.")
    lines.append(f"- **url_reach_rate = {pct(metrics['url_reach_rate'])}** ({metrics['gold_reached']}/{metrics['url_attempts']}): a domain-matched opaque id resolved to the exact gold URL in the `/read` response. "
                 f"{metrics['fallback_reads']} URL cases had no domain-matched candidate and fell back to reading the first result (off-gold).")
    lines.append(f"- **url_e2e_rate = {pct(metrics['url_e2e_rate'])}** ({metrics['gold_read_ok']}/{metrics['url_attempts']}): gold URL reached *and* its page text returned.")
    lines.append(f"- **prompt_chain_rate = {pct(metrics['prompt_chain_rate'])}** ({metrics['prompt_chain_ok']}/{len(smoke['attempts'])}): `/prompt` with `web:allowed` reached `web_read` and the faux model quoted its text.")
    lines.append(f"- Search latency p50/p90: {metrics['search_ms_p50']}/{metrics['search_ms_p90']} ms. Read latency p50/p90: {metrics['read_ms_p50']}/{metrics['read_ms_p90']} ms.")
    lines.append(f"- Refusals: {json.dumps(metrics['errors'], ensure_ascii=False)}")
    lines.append("")
    lines.append("## 3. Read quality against the 5 gold URLs")
    lines.append("")
    lines.append("Markers are exact phrases taken from an independent host-side HTML fetch of each URL, never from `web_read`. "
                 "`head` markers sit inside the first 6000 visible characters; `deep` markers sit after them (verified against the "
                 "Camofox full-text ceiling fetched in this run). `fidelity` = share of markers present; `completeness` = "
                 "`len(text) / len(Camofox full innerText)`; `prose` = share of characters in lines with at least 8 words "
                 "(a nav/boilerplate proxy); `envelope` = `untrusted`, sha256, ≤6000 chars, matching URL and title.")
    lines.append("")
    url_rows = []
    for item in gold["urls"]:
        rows = [u for u in url_scores if u["urlId"] == item["id"]]
        url_rows.append([
            item["id"], item["url"],
            f"{sum(1 for u in rows if u['goldReached'])}/{len(rows)}",
            f"{sum(1 for u in rows if u['readOk'])}/{len(rows)}",
            pct(mean([u["fidelity"] for u in rows])),
            pct(mean([u["deepFidelity"] for u in rows if u["deepFidelity"] is not None])) if any(u["deepFidelity"] is not None for u in rows) else "n/a",
            pct(mean([u["completeness"] for u in rows])),
            pct(mean([u["proseRatio"] for u in rows])),
            f"{mean([u['qualityScore'] for u in rows]):.3f}",
            f"{sum(1 for u in rows if u['usable'])}/{len(rows)}",
        ])
    lines.append(table(["URL", "Target", "Reached", "Read OK", "Fidelity", "Deep fid.", "Complete", "Prose", "Score", "Usable"], url_rows))
    lines.append("")
    quality_rows = []
    for item in gold["urls"]:
        rows = [u for u in url_scores if u["urlId"] == item["id"]]
        first = rows[0] if rows else None
        quality_rows.append([
            item["id"],
            refs["urls"][item["id"]]["ceiling"]["chars"],
            first["textChars"] if first else 0,
            first["markdownSignals"] if first else 0,
            "yes" if first and first["markdownPreserved"] else "no",
            ", ".join(first["missingMarkers"][:3]) if first and first["missingMarkers"] else "none",
        ])
    lines.append(table(["URL", "Full page (ceiling chars)", "Delivered chars", "Markdown signals", "Markdown preserved", "Missing markers (rep 1)"], quality_rows))
    lines.append("")
    lines.append(f"- **quality_rate (usable) = {pct(metrics['quality_rate'])}** ({metrics['usable_reads']}/{metrics['url_attempts']}): "
                 f"`read_ok && envelope_ok && fidelity >= 0.60 && quality_score >= 0.70`. Conditional on a successful read of the gold URL, "
                 f"mean fidelity is {pct(metrics['mean_fidelity_delivered'])} and the usable rate is {pct(metrics['delivered_quality_rate'])} "
                 f"(n={metrics['delivered_reads']}).")
    lines.append(f"- **mean_quality_score = {metrics['mean_quality_score']:.3f}**; `0.40*fidelity + 0.25*completeness + 0.15*prose + 0.20*envelope`.")
    lines.append(f"- **mean_fidelity = {pct(metrics['mean_fidelity'])}**, **mean_deep_fidelity = {pct(metrics['mean_deep_fidelity'])}** (deep markers only, {metrics['deep_marker_attempts']} attempts).")
    lines.append(f"- **truncated_rate = {pct(metrics['truncated_rate'])}**, **focus_window_rate = {pct(metrics['focus_window_rate'])}** (of truncated reads). The head+focus window is meant to recover deep markers without raising the 6000-character cap.")
    lines.append(f"- **markdown_preservation_rate = {pct(metrics['markdown_preservation_rate'])}**. "
                 f"`web_read` returns Markdown-like semantic blocks: `agent/websearch.ts` renders headings, lists, code and tables in the browser, caps that text at 60000 characters, then selects a `MAX_READ_CHARS = 6000` head+focus window.")
    lines.append("")
    lines.append("## 4. Query intent quality against the 5 gold queries")
    lines.append("")
    lines.append("The tool does not return URLs in search results, so relevance is judged on `domain`, `title` and `snippet` "
                 "by the pre-registered rubric in `gold.json`: allowlisted domains, or at least two topical terms; excluded "
                 "domains and excluded title/URL patterns are judged irrelevant first. Per-result judgments are stored in "
                 "`metrics.json` and `raw/*.json` for human re-judging.")
    lines.append("")
    query_rows = []
    for item in gold["queries"]:
        rows = [q for q in query_scores if q["queryId"] == item["id"]]
        query_rows.append([
            item["id"], item["intent"][:70],
            pct(mean([q["precision5"] for q in rows])),
            pct(mean([q["precision8"] for q in rows])),
            pct(mean([1.0 if q["top1Relevant"] else 0.0 for q in rows])),
            pct(mean([1.0 if q["anyRelevant"] else 0.0 for q in rows])),
            f"{mean([q['reciprocalRank'] for q in rows]):.3f}",
            mean([q["resultCount"] for q in rows]),
        ])
    lines.append(table(["Query", "Intent", "P@5", "P@8", "Top-1 relevant", "Any relevant", "MRR", "Mean results"], query_rows))
    lines.append("")
    lines.append(f"- **query_intent_rate (mean P@5) = {pct(metrics['query_intent_rate'])}**; "
                 f"**top1_relevance_rate = {pct(metrics['top1_relevance_rate'])}**; "
                 f"**any_relevant_rate = {pct(metrics['any_relevant_rate'])}**; **MRR = {metrics['mrr']:.3f}**.")
    lines.append("")
    lines.append("## 5. Findings")
    lines.append("")
    for finding in metrics["findings"]:
        lines.append(f"- {finding}")
    lines.append("")
    lines.append("## 6. Limits and threats to validity")
    lines.append("")
    lines.append("- The live index is volatile: results depend on SearXNG engine health, time and locale. The run stores every raw response so the judgement can be re-checked, but repeating it later can legitimately produce different numbers.")
    lines.append("- This stack runs the deterministic faux provider. The scored matrix drives the tool transport from inside the agent container (same headers as `web_search`/`web_read`); the model-in-the-loop path is covered only by the three `/prompt` smoke attempts, whose query is fixed by the faux script.")
    lines.append("- `AGENT_EGRESS` was `" + manifest["host_env_AGENT_EGRESS"] + "` in this stack. Direct isolation of SearXNG/Camofox was measured, not assumed; with `off` the per-user network is also `--internal`.")
    lines.append("- Relevance is a deterministic rubric, not a human panel: domain allowlists and two-term topical matching can credit a blog that a human would reject, or reject an unlisted but authoritative domain.")
    lines.append("- `prose_ratio` is a proxy for boilerplate; code-heavy documentation pages score lower by construction.")
    lines.append("- Markdown preservation is scored on structure signals in the returned text, not on a diff against a canonical Markdown conversion; the browser renders semantic blocks as Markdown-like text without a library.")
    lines.append(f"- {manifest['counts']['cases']['expected']} cases only. The sample measures one stack on one day, not a fleet or a long-running SLA.")
    lines.append("")
    lines.append("## 7. Reproduction and artifacts")
    lines.append("")
    lines.append("```bash")
    lines.append("cd e2e-test/websearch-eval")
    lines.append("python3 harness.py discover                       # optional pre-gold probe")
    lines.append(f"python3 harness.py run --repeats {manifest['repeats']} --run-id NEW-ID")
    lines.append(f"python3 analyze.py --run-id {run_id}")
    lines.append("```")
    lines.append("")
    lines.append(f"- `runs/{run_id}/manifest.json` — environment fingerprint")
    lines.append(f"- `runs/{run_id}/connectivity.json` — host, node and agent reachability probes")
    lines.append(f"- `runs/{run_id}/references/` — independent HTML fetch, cleaned text, Camofox full-text ceiling, marker offsets")
    lines.append(f"- `runs/{run_id}/attempts.jsonl` + `raw/*.json` — every attempt, full HTTP bodies and page text")
    lines.append(f"- `runs/{run_id}/prompt-smoke.json` — `/prompt` replies through Caddy")
    lines.append(f"- `runs/{run_id}/pre-gold/` + `discovery-degraded-1009.json` — pre-registration evidence and the observed upstream degradation")
    lines.append(f"- `metrics.json` — machine-readable scores; `REPORT.md` — this report")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    run_dir = RUNS / args.run_id
    gold, manifest, attempts, conn, refs, smoke, _ = load(run_dir)
    query_scores = score_query_attempts(gold, attempts)
    url_scores = score_url_attempts(gold, attempts, refs, run_dir)

    search_ms = [a["search"]["ms"] for a in attempts if isinstance(a["search"]["ms"], (int, float))]
    all_reads = [entry for a in attempts for entry in a.get("reads", [])]
    read_ms = [entry["ms"] for entry in all_reads if isinstance(entry["ms"], (int, float))]
    errors: dict[str, int] = {}
    for a in attempts:
        entries = [("search", a["search"])] + [("read", entry) for entry in a.get("reads", [])]
        for phase, entry in entries:
            if entry and entry.get("status") not in (200, None):
                key = f"{phase}:{entry['status']}:{entry.get('reported_error') or entry.get('error') or 'unnamed'}"
                errors[key] = errors.get(key, 0) + 1

    deep_values = [u["deepFidelity"] for u in url_scores if u["deepFidelity"] is not None]
    metrics = {
        "run_id": args.run_id,
        "gold_sha256": manifest["gold_sha256"],
        "attempts": len(attempts),
        "served_searches": sum(1 for a in attempts if a["search"]["status"] == 200 and a["search"]["count"] > 0),
        "search_hit_rate": mean([1.0 if a["search"]["status"] == 200 and a["search"]["count"] > 0 else 0.0 for a in attempts]),
        "read_attempts": len(all_reads),
        "ok_reads": sum(1 for entry in all_reads if entry["status"] == 200 and (entry["text_chars"] or 0) > 0),
        "read_hit_rate": mean([1.0 if entry["status"] == 200 and (entry["text_chars"] or 0) > 0 else 0.0 for entry in all_reads]),
        "fallback_reads": sum(1 for a in attempts if a.get("fallback")),
        "url_attempts": len(url_scores),
        "gold_reached": sum(1 for u in url_scores if u["goldReached"]),
        "url_reach_rate": mean([1.0 if u["goldReached"] else 0.0 for u in url_scores]),
        "gold_read_ok": sum(1 for u in url_scores if u["goldReached"] and u["readOk"]),
        "url_e2e_rate": mean([1.0 if u["goldReached"] and u["readOk"] else 0.0 for u in url_scores]),
        "usable_reads": sum(1 for u in url_scores if u["usable"]),
        "quality_rate": mean([1.0 if u["usable"] else 0.0 for u in url_scores]),
        "mean_quality_score": mean([u["qualityScore"] for u in url_scores]),
        "mean_fidelity": mean([u["fidelity"] for u in url_scores]),
        "delivered_reads": sum(1 for u in url_scores if u["readOk"] and u["goldReached"]),
        "mean_fidelity_delivered": mean([u["fidelity"] for u in url_scores if u["readOk"] and u["goldReached"]]),
        "delivered_quality_rate": mean([1.0 if u["usable"] else 0.0 for u in url_scores if u["readOk"] and u["goldReached"]]),
        "mean_deep_fidelity": mean(deep_values),
        "deep_marker_attempts": len(deep_values),
        "truncated_rate": mean([1.0 if u["truncated"] else 0.0 for u in url_scores]),
        "focus_window_rate": mean([1.0 if u["windowMode"] == "head+focus" else 0.0 for u in url_scores if u["truncated"]]),
        "mean_completeness": mean([u["completeness"] for u in url_scores]),
        "mean_prose_ratio": mean([u["proseRatio"] for u in url_scores]),
        "mean_head_fidelity": mean([u["headFidelity"] for u in url_scores]),
        "markdown_preservation_rate": mean([1.0 if u["markdownPreserved"] else 0.0 for u in url_scores]),
        "query_intent_rate": mean([q["precision5"] for q in query_scores]),
        "mean_precision8": mean([q["precision8"] for q in query_scores]),
        "top1_relevance_rate": mean([1.0 if q["top1Relevant"] else 0.0 for q in query_scores]),
        "any_relevant_rate": mean([1.0 if q["anyRelevant"] else 0.0 for q in query_scores]),
        "mrr": mean([q["reciprocalRank"] for q in query_scores]),
        "prompt_chain_rate": mean([1.0 if attempt["tool_chain_ok"] else 0.0 for attempt in smoke["attempts"]]),
        "prompt_chain_ok": sum(1 for attempt in smoke["attempts"] if attempt["tool_chain_ok"]),
        "search_ms_p50": p(search_ms, 50),
        "search_ms_p90": p(search_ms, 90),
        "read_ms_p50": p(read_ms, 50),
        "read_ms_p90": p(read_ms, 90),
        "errors": errors,
        "per_url": url_scores,
        "per_query": query_scores,
        "reachability": reachability(conn, manifest),
    }

    findings = []
    reach = reachability(conn, manifest)
    direct = [row for row in reach if "DIRECT" in row["edge"]]
    if all(row["verdict"] == "isolated" for row in direct):
        findings.append("SearXNG and Camofox answered from the web-search node, but the agent container could not reach either directly: the per-user network exposes only the node, as RFC 0016 requires.")
    else:
        findings.append("A direct agent-to-upstream path was reachable: this contradicts RFC 0016 and needs investigation.")
    findings.append(f"`/search` returns no URL (only `sourceId`, `domain`, `title`, `snippet`): a specific gold URL is reachable only by reading a domain-matched id and comparing the URL revealed in `/read`. It resolved in {pct(metrics['url_reach_rate'])} of URL cases.")
    findings.append(f"Queries were served {pct(metrics['search_hit_rate'])} of the time and pages were extracted {pct(metrics['read_hit_rate'])} of attempted reads; the `/prompt` chain reached `web_read` in {metrics['prompt_chain_ok']}/{len(smoke['attempts'])} attempts.")
    findings.append(f"Search results matched the pre-registered intent with P@5 {pct(metrics['query_intent_rate'])} and top-1 relevance {pct(metrics['top1_relevance_rate'])}.")
    failed = [u for u in url_scores if not (u["readOk"] and u["goldReached"])]
    detail = ", ".join(f"{u['id']} (read HTTP {u['readStatus']}, gold reached {u['goldReached']})" for u in failed) or "none"
    findings.append(f"Of {metrics['url_attempts']} URL cases, {metrics['delivered_reads']} delivered the gold page; conditional on delivery, mean fidelity is {pct(metrics['mean_fidelity_delivered'])} and {pct(metrics['delivered_quality_rate'])} are usable. Non-deliveries: {detail}. A 502 `read_unavailable` is an upstream Camofox failure, not a search miss.")
    findings.append(f"`web_read` delivers Markdown-like semantic blocks in a 6000-character head+focus window (markdown structure in {pct(metrics['markdown_preservation_rate'])} of reads). Long pages are explicitly truncated: truncated_rate {pct(metrics['truncated_rate'])}, focus_window_rate {pct(metrics['focus_window_rate'])}; mean completeness {pct(metrics['mean_completeness'])}, deep-marker fidelity {pct(metrics['mean_deep_fidelity'])} versus head-marker fidelity {pct(metrics['mean_head_fidelity'])}.")
    worst = sorted(url_scores, key=lambda u: u["qualityScore"])[:2]
    if worst:
        findings.append("Lowest-scoring URLs: " + ", ".join(f"{u['urlId']} ({u['qualityScore']:.3f}, {u['textChars']} chars, {len(u['missingMarkers'])} missing markers)" for u in worst) + ".")
    if metrics["errors"]:
        findings.append("Named refusals observed: " + "; ".join(f"{key} ×{value}" for key, value in sorted(metrics["errors"].items())) + ".")
    metrics["findings"] = findings

    text = report(args.run_id, gold, manifest, conn, refs, smoke, query_scores, url_scores, attempts, metrics)
    (run_dir / "metrics.json").write_text(json.dumps(metrics, indent=2))
    (run_dir / "REPORT.md").write_text(text)
    (HERE / "REPORT.md").write_text(text)
    print(json.dumps({key: value for key, value in metrics.items() if not isinstance(value, list)}, indent=2))
    print(f"wrote {run_dir / 'REPORT.md'} and {HERE / 'REPORT.md'}")


if __name__ == "__main__":
    main()
