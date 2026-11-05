# Web-search evaluation (SearXNG + Camofox through the RFC 0016 node)

An experiment, not a gate. It answers two questions against a running stack:

1. Is the operator's search stack reachable **in real time** from a sandbox agent container?
2. How often is a query served, how faithful is the page text for a specific URL, and how well do the returned URLs match the query intent?

The unit under test is the whole edge: `agent container -> web-search node -> SearXNG/Camofox -> live web`. The scored calls are issued from **inside the agent container** with the exact headers of `agent/web-tools.ts` `postNode()`. Run registration happens in the manager container, which owns `MANAGER_TOKEN`. Nothing is stubbed: no fake search stack, no recorded responses.

## What "reachable" means here

RFC 0016 deliberately forbids a direct path. The agent must reach only its own node on `:8082`; the node alone is dual-homed onto `websearch-in`, where SearXNG and Camofox live. So the reachability probe has three layers:

| Layer | Expected |
| --- | --- |
| host -> published SearXNG/Camofox ports; node -> SearXNG/Camofox | reachable |
| agent -> node `/health`, `/status`, TCP | reachable |
| agent -> SearXNG/Camofox directly (TCP, HTTP, DNS) | blocked (negative control) |

A direct success is reported as `DIRECT LEAK`, not as a pass.

## Gold dataset

`gold.json` was frozen **before** the scored run:

- 5 queries, each with an intent statement and a deterministic relevance rubric (allowlisted domains, excluded domains/URL patterns, topical terms).
- 5 URLs, each paired with one of the queries, with content markers taken from an **independent host-side HTML fetch** of that URL, never from `web_read`. `head_markers` sit inside the first 6000 visible characters; `deep_markers` sit after them.

Queries and URLs were selected after a discovery pass against the live index and browser. Raw discovery evidence lives in `runs/<run-id>/pre-gold/`; `harness.py discover` reproduces a pre-gold style probe.

A "specific URL" cannot be passed to `web_read` by design, and the `results` array of `/search` returns **no URL at all** (only `sourceId`, `domain`, `title`, `snippet`). The harness therefore issues the URL's paired query, selects up to 3 results whose `domain` matches the gold domain, reads their opaque ids, and compares the URL revealed in the `/read` page with the gold URL. `url_reach_rate` measures how often that resolution works; it is part of the result, not an assumption. When no domain-matched result exists, the harness reads the first result as an off-gold fallback (recorded as `fallback:true`) to keep measuring extraction availability.

## Metrics

| Metric | Definition |
| --- | --- |
| `search_hit_rate` | searches with HTTP 200 and >= 1 result / all search attempts |
| `read_hit_rate` | reads with HTTP 200 and non-empty text / all attempted reads (including off-gold fallbacks) |
| `url_reach_rate` | a domain-matched `sourceId` resolved to the exact gold URL / URL attempts |
| `url_e2e_rate` | gold URL found **and** read succeeded / URL attempts |
| `prompt_chain_rate` | `/prompt web:allowed` replies whose faux model quoted `web_read` text / smoke attempts |
| `quality_rate` | share of URL attempts with `read_ok && envelope_ok && fidelity >= 0.60 && quality_score >= 0.70` |
| `quality_score` | `0.40*fidelity + 0.25*completeness + 0.15*prose_ratio + 0.20*envelope` |
| `fidelity` | share of gold markers present in the returned text (also split into head/deep) |
| `completeness` | `len(returned text) / len(Camofox full innerText ceiling)` |
| `prose_ratio` | share of characters in lines with >= 8 words (nav/boilerplate proxy) |
| `envelope` | `untrusted:true`, sha256 matches the text, <= 6000 chars, URL/title match, `truncated`/`totalChars` present |
| `truncated_rate` | share of reads where the full visible page is longer than the delivered 6000 characters |
| `focus_window_rate` | share of truncated reads whose diagnostics report `window.mode == "head+focus"` |
| `deep_fidelity` | share of deep markers present in the delivered text; the head+focus window is meant to recover these |
| `markdown_preservation_rate` | share of reads carrying >= 2 Markdown structure signals; the browser now renders headings, lists, code and tables as Markdown-like text |
| `query_intent_rate` | mean precision@5 of pre-registered relevance judgments |
| `top1_relevance_rate`, `any_relevant_rate`, `MRR` | rank-based intent measures |

All judgments are recomputable: `metrics.json` holds per-result relevance flags and URLs, `raw/*.json` holds full HTTP bodies and page text.

## Protocol version

`agent/web-protocol.ts` defines one schema set for the node, the tools and the two upstream clients. `/search` and `/read` return envelopes with `requestId` and `diagnostics`; the model still receives only the compact `results` array and the `page` object. `structuredOutput` carries the full envelope to program callers. `page.text` is at most 6000 characters, selected from a head window plus a focus window around server-side query/snippet terms; `truncated` and `totalChars` state what was omitted. Search results still contain no URL.

## Run

Prerequisites: `./dev.sh up`, the operator's SearXNG/Camofox containers attached to `websearch-in`, and `CAMOFOX_API_KEY` in `.env` (used only for the reference ceiling; the node already holds its own copy).

`gold.json` version 3 deliberately omits `lang`: setting `language=en` selects a different SearXNG engine set and makes the target URLs unstable. The scored run uses the node's default engine set, the same one used by the scripted `/prompt` path. Version 3 keeps the frozen queries, URLs and markers of version 2; it documents the new envelopes and the head+focus window.

```bash
cd e2e-test/websearch-eval
python3 harness.py discover                        # optional pre-gold probe
python3 harness.py run --repeats 3 --run-id 20261105T120000Z
python3 analyze.py --run-id 20261105T120000Z
```

`run` provisions a fresh sandbox through Caddy (`/u/<user>/status`), keeps it alive with `/u/<user>/health`, fetches independent references, measures reachability, runs the scored matrix and three `/prompt` smokes. It needs Docker, `curl`, `psql` through compose, and Python 3 (stdlib only). No secret is printed or written: the manager computes the control token in its own container, and the harness never stores run tokens.

## Artifacts

`runs/<run-id>/` (untracked runtime evidence, see `.gitignore`):

- `manifest.json` — images, image ids, container names, versions, git sha, gold sha256, env flags
- `connectivity.json` — host/node/agent probes, `/etc/hosts`, network internality
- `references/` — raw HTML, cleaned text, Camofox full-text ceiling, marker offsets, sha256
- `attempts.jsonl` — one attempt per line: status, latency, result list, read envelope, hashes
- `raw/<id>.json` — full search/read bodies including page text
- `prompt-smoke.json` — `/prompt` replies
- `metrics.json`, `REPORT.md` — scores and the generated analysis

`REPORT.md` at this directory root is the tracked copy of the latest analysis.

## Stored runs

| Run | Condition | Repetitions | Role |
| --- | --- | --- | --- |
| `20261105T100715Z` | live stack, 4 SearXNG engines suspended but default set healthy | 3 | main report (`REPORT.md`) |
| `pilot2-20261105` | live stack, all default engines healthy | 1 | healthy-index reference, same frozen queries/URLs/markers |

These runs and `REPORT.md` predate the shared envelopes, `structuredOutput`, `requestId`, diagnostics and the head+focus window. Do not compare their numbers directly with a post-change run: use a new run id and date, and note the new `gold.json` sha256.

`pilot-20261105` was a pre-fix probe (it assumed `/search` returns URLs); it was removed after the tool contract was corrected. The degraded discovery snapshot and the Camofox incident log are under `runs/20261105T100715Z/pre-gold/` and `discovery-degraded-1009.json`.

## Known limits

The live index is volatile; the faux provider is scripted (the matrix drives the tool transport, not a free-form model); relevance is a deterministic rubric rather than a human panel; `prose_ratio` penalises code-heavy docs; one run measures one stack on one day. The report states the measured `AGENT_EGRESS` value: with `open`, direct isolation relies on Docker bridge isolation and is measured, not assumed.

The browser expression now caps rendered page text at 60000 characters (not 20000) and the node selects a 6000-character head+focus window. `completeness` remains a length ratio against the independent full-text ceiling, so it can stay below 1 even when the selected window contains every gold marker; use `fidelity` and `deep_fidelity` to judge that choice.
