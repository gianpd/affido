# Web-search evaluation — `20261105T100715Z`

> Historical report. It predates the shared web protocol: response envelopes, `structuredOutput`, `requestId`, diagnostics, the head+focus 6000-character window and Markdown-like page blocks. The numbers below are not a baseline for the new contract; a post-change run needs a new run id, date and `gold.json` sha256.

Measured 2026-11-05T10:14:24+00:00 → 2026-11-05T10:15:55+00:00. Gold `gold.json` sha256 `c20b3357e8166567…`, git `1eabbe5066`, agent image `sha256:9fb980ef037e…`, Node `v24.22.1`, Camofox `1.11.2`, Docker `29.9.2`.
3 repetitions × 5 queries + 3 × 5 URLs = 30 scored cases (30 observed). Every scored call was issued from inside `uweval-20261105T100715Z-62fced8047d9` with the exact headers of `postNode()`.

## 1. Real-time reachability

| Edge | Observed | Expected | Verdict |
| --- | --- | --- | --- |
| host -> SearXNG published :8080 | HTTP 200, 20 results, 4464 ms | 200 with results | reachable |
| host -> Camofox published :9377 | HTTP 200, 1 ms | 200 | reachable |
| web-search node -> SearXNG /search | HTTP 200, 20 results, 4278 ms | 200 with results | reachable |
| web-search node -> Camofox /health | HTTP 200, 4 ms | 200 | reachable |
| host -> Camofox functional tab (open/evaluate/close) | open=200, evaluate=200, close=200, 4386 ms | 200/200/200 | reachable |
| agent container -> web-search node :8082 | TCP ok, /health HTTP 200, /status HTTP 200 | TCP ok, HTTP 200 | reachable |
| agent container -> searxng DIRECT (negative control) | TCP False (ENETUNREACH), HTTP 0 (fetch failed), DNS False | blocked: RFC 0016 gives egress only to the node | isolated |
| agent container -> camofox DIRECT (negative control) | TCP False (ENETUNREACH), HTTP 0 (fetch failed), DNS False | blocked: RFC 0016 gives egress only to the node | isolated |
| topology | websearch-in internal=true; websearch-out internal=false; AGENT_EGRESS=open | websearch-in internal=true, node never on websearch-out | as designed |

SearXNG engine health at measurement time: [["brave", "Suspended: too many requests"], ["duckduckgo", "Suspended: access denied"], ["startpage", "Suspended: CAPTCHA"], ["wikidata", "Suspended: access denied"]]. `agent/websearch.ts` cascades from the default engine set to single engines when it gets an empty 200, so a suspended default engine does not necessarily mean `no results`.

Service state: at measurement time the published SearXNG endpoint answered with 20 results and reported 4 suspended/unresponsive engines. `agent/websearch.ts` falls back to single engines on an empty 200, so a partially suspended engine set does not by itself mean `no results`. An earlier discovery pass saw the default set return empty 200s and Camofox log a tab-create timeout plus an automatic browser relaunch; that evidence is kept in `runs/20261105T100715Z/discovery-degraded-1009.json` and `runs/20261105T100715Z/pre-gold/` when present.

The agent container cannot name or dial a page: `web_read` takes only an opaque `sourceId`, and `/search` returns no URL at all. The direct TCP/HTTP/DNS checks are negative controls — they must fail, or the RFC 0016 isolation claim is broken. The end-to-end proof that the stack actually works is the search/read hit rate below, plus the `/prompt` smoke.

## 2. Hit rate

| Query | Text | Served | Rate | p50 | p90 |
| --- | --- | --- | --- | --- | --- |
| Q1 | Node.js 24 run TypeScript natively type stripping | 3/3 | 100.0% | 298 ms | 362 ms |
| Q2 | Svelte 5 runes $state documentation | 3/3 | 100.0% | 273 ms | 281 ms |
| Q3 | HTTP status code 429 MDN | 3/3 | 100.0% | 263 ms | 295 ms |
| Q4 | ISO 8601 date and time format wikipedia | 3/3 | 100.0% | 262 ms | 277 ms |
| Q5 | example domain illustrative examples | 3/3 | 100.0% | 262 ms | 324 ms |

- **search_hit_rate = 100.0%** (30/30 search attempts). A search is *served* when HTTP 200 returns at least one result.
- **read_hit_rate = 93.8%** (15/16 read attempts). A read is a hit when HTTP 200 returns non-empty text.
- **url_reach_rate = 93.3%** (14/15): a domain-matched opaque id resolved to the exact gold URL in the `/read` response. 0 URL cases had no domain-matched candidate and fell back to reading the first result (off-gold).
- **url_e2e_rate = 93.3%** (14/15): gold URL reached *and* its page text returned.
- **prompt_chain_rate = 100.0%** (3/3): `/prompt` with `web:allowed` reached `web_read` and the faux model quoted its text.
- Search latency p50/p90: 276/362 ms. Read latency p50/p90: 559/4541 ms.
- Refusals: {"read:502:read_unavailable": 1}

## 3. Read quality against the 5 gold URLs

Markers are exact phrases taken from an independent host-side HTML fetch of each URL, never from `web_read`. `head` markers sit inside the first 6000 visible characters; `deep` markers sit after them (verified against the Camofox full-text ceiling fetched in this run). `fidelity` = share of markers present; `completeness` = `len(text) / len(Camofox full innerText)`; `prose` = share of characters in lines with at least 8 words (a nav/boilerplate proxy); `envelope` = `untrusted`, sha256, ≤6000 chars, matching URL and title.

| URL | Target | Reached | Read OK | Fidelity | Deep fid. | Complete | Prose | Score | Usable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| U1 | https://nodejs.org/learn/typescript/run-natively | 3/3 | 3/3 | 100.0% | n/a | 100.0% | 49.3% | 0.924 | 3/3 |
| U2 | https://svelte.dev/docs/svelte/$state | 2/3 | 2/3 | 44.4% | 0.0% | 42.2% | 35.1% | 0.469 | 2/3 |
| U3 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429 | 3/3 | 3/3 | 100.0% | n/a | 100.0% | 30.7% | 0.896 | 3/3 |
| U4 | https://en.wikipedia.org/wiki/ISO_8601 | 3/3 | 3/3 | 50.0% | 0.0% | 11.4% | 80.9% | 0.550 | 0/3 |
| U5 | https://www.example.com/ | 3/3 | 3/3 | 100.0% | n/a | 100.0% | 93.2% | 0.990 | 3/3 |

| URL | Full page (ceiling chars) | Delivered chars | Markdown signals | Markdown preserved | Missing markers (rep 1) |
| --- | --- | --- | --- | --- | --- |
| U1 | 5411 | 5411 | 0 | no | none |
| U2 | 9468 | 6000 | 0 | no | updates are synchronized, Use this feature sparingly |
| U3 | 4391 | 4391 | 1 | no | none |
| U4 | 52508 | 6000 | 0 | no | Time zone designators, Coordinated Universal Time, Date and time values are ordered from the largest |
| U5 | 917 | 917 | 0 | no | none |

- **quality_rate (usable) = 73.3%** (11/15): `read_ok && envelope_ok && fidelity >= 0.60 && quality_score >= 0.70`. Conditional on a successful read of the gold URL, mean fidelity is 84.5% and the usable rate is 78.6% (n=14).
- **mean_quality_score = 0.766**; `0.40*fidelity + 0.25*completeness + 0.15*prose + 0.20*envelope`.
- **mean_fidelity = 78.9%**, **mean_deep_fidelity = 0.0%** (deep markers only, 6 attempts).
- **markdown_preservation_rate = 0.0%**. `web_read` returns `document.body.innerText` (plain text), not Markdown: `agent/websearch.ts` uses `PAGE_EXPRESSION` with `innerText.slice(0, 20000)` and caps the reply at `MAX_READ_CHARS = 6000`.

## 4. Query intent quality against the 5 gold queries

The tool does not return URLs in search results, so relevance is judged on `domain`, `title` and `snippet` by the pre-registered rubric in `gold.json`: allowlisted domains, or at least two topical terms; excluded domains and excluded title/URL patterns are judged irrelevant first. Per-result judgments are stored in `metrics.json` and `raw/*.json` for human re-judging.

| Query | Intent | P@5 | P@8 | Top-1 relevant | Any relevant | MRR | Mean results |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q1 | Find the official documentation for running TypeScript natively in Nod | 100.0% | 100.0% | 100.0% | 100.0% | 1.000 | 8.0 |
| Q2 | Find the official Svelte 5 documentation page for the $state rune. | 100.0% | 100.0% | 100.0% | 100.0% | 1.000 | 8.0 |
| Q3 | Find the canonical HTTP 429 Too Many Requests reference page and its s | 100.0% | 100.0% | 100.0% | 100.0% | 1.000 | 8.0 |
| Q4 | Find the encyclopedic reference for the ISO 8601 date/time representat | 66.7% | 70.8% | 100.0% | 100.0% | 1.000 | 8.0 |
| Q5 | Find the authoritative explanation of reserved example domains and the | 60.0% | 50.0% | 100.0% | 100.0% | 1.000 | 8.0 |

- **query_intent_rate (mean P@5) = 85.3%**; **top1_relevance_rate = 100.0%**; **any_relevant_rate = 100.0%**; **MRR = 1.000**.

## 5. Findings

- SearXNG and Camofox answered from the web-search node, but the agent container could not reach either directly: the per-user network exposes only the node, as RFC 0016 requires.
- `/search` returns no URL (only `sourceId`, `domain`, `title`, `snippet`): a specific gold URL is reachable only by reading a domain-matched id and comparing the URL revealed in `/read`. It resolved in 93.3% of URL cases.
- Queries were served 100.0% of the time and pages were extracted 93.8% of attempted reads; the `/prompt` chain reached `web_read` in 3/3 attempts.
- Search results matched the pre-registered intent with P@5 85.3% and top-1 relevance 100.0%.
- Of 15 URL cases, 14 delivered the gold page; conditional on delivery, mean fidelity is 84.5% and 78.6% are usable. Non-deliveries: u-U2-r2 (read HTTP 502, gold reached False). A 502 `read_unavailable` is an upstream Camofox failure, not a search miss.
- `web_read` delivers plain text, not Markdown (markdown structure preserved in 0.0% of reads). It caps at 6000 characters of `innerText`, so long pages lose their substantive body: mean completeness 70.7%, deep-marker fidelity 0.0% versus head-marker fidelity 93.3%.
- Lowest-scoring URLs: U2 (0.000, 0 chars, 6 missing markers), U4 (0.550, 6000 chars, 4 missing markers).
- Named refusals observed: read:502:read_unavailable ×1.

## 6. Limits and threats to validity

- The live index is volatile: results depend on SearXNG engine health, time and locale. The run stores every raw response so the judgement can be re-checked, but repeating it later can legitimately produce different numbers.
- This stack runs the deterministic faux provider. The scored matrix drives the tool transport from inside the agent container (same headers as `web_search`/`web_read`); the model-in-the-loop path is covered only by the three `/prompt` smoke attempts, whose query is fixed by the faux script.
- `AGENT_EGRESS` was `open` in this stack. Direct isolation of SearXNG/Camofox was measured, not assumed; with `off` the per-user network is also `--internal`.
- Relevance is a deterministic rubric, not a human panel: domain allowlists and two-term topical matching can credit a blog that a human would reject, or reject an unlisted but authoritative domain.
- `prose_ratio` is a proxy for boilerplate; code-heavy documentation pages score lower by construction.
- Markdown preservation is scored on structure signals in the returned text, not on a diff against a canonical Markdown conversion; the node never requests one.
- 30 cases only. The sample measures one stack on one day, not a fleet or a long-running SLA.

## 7. Reproduction and artifacts

```bash
cd e2e-test/websearch-eval
python3 harness.py discover                       # optional pre-gold probe
python3 harness.py run --repeats 3 --run-id NEW-ID
python3 analyze.py --run-id 20261105T100715Z
```

- `runs/20261105T100715Z/manifest.json` — environment fingerprint
- `runs/20261105T100715Z/connectivity.json` — host, node and agent reachability probes
- `runs/20261105T100715Z/references/` — independent HTML fetch, cleaned text, Camofox full-text ceiling, marker offsets
- `runs/20261105T100715Z/attempts.jsonl` + `raw/*.json` — every attempt, full HTTP bodies and page text
- `runs/20261105T100715Z/prompt-smoke.json` — `/prompt` replies through Caddy
- `runs/20261105T100715Z/pre-gold/` + `discovery-degraded-1009.json` — pre-registration evidence and the observed upstream degradation
- `metrics.json` — machine-readable scores; `REPORT.md` — this report
