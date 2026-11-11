# Web-search evaluation — `post-5f0dd0c-20261105T121306Z`

Measured 2026-11-05T12:13:30+00:00 → 2026-11-05T12:21:38+00:00. Gold `gold.json` sha256 `589097208fd1f21c…`, git `5f0dd0ca7c`, agent image `sha256:6404e977ebe7…`, Node `v24.22.1`, Camofox `1.11.2`, Docker `29.9.2`.
3 repetitions × 5 queries + 3 × 5 URLs = 30 scored cases (30 observed). Every scored call was issued from inside `uweval-post-5f0dd0c-20261105T1213-a8fddbb3f2b4` with the exact headers of `postNode()`.

## 1. Real-time reachability

| Edge | Observed | Expected | Verdict |
| --- | --- | --- | --- |
| host -> SearXNG published :8080 | HTTP 200, 0 results, 10004 ms | 200 with results | reachable |
| host -> Camofox published :9377 | HTTP 200, 1 ms | 200 | reachable |
| web-search node -> SearXNG /search | HTTP 200, 0 results, 10195 ms | 200 with results | reachable |
| web-search node -> Camofox /health | HTTP 200, 85 ms | 200 | reachable |
| host -> Camofox functional tab (open/evaluate/close) | open=200, evaluate=200, close=200, 4360 ms | 200/200/200 | reachable |
| agent container -> web-search node :8082 | TCP ok, /health HTTP 200, /status HTTP 200 | TCP ok, HTTP 200 | reachable |
| agent container -> searxng DIRECT (negative control) | TCP False (ENETUNREACH), HTTP 0 (fetch failed), DNS False | blocked: RFC 0016 gives egress only to the node | isolated |
| agent container -> camofox DIRECT (negative control) | TCP False (ENETUNREACH), HTTP 0 (fetch failed), DNS False | blocked: RFC 0016 gives egress only to the node | isolated |
| topology | websearch-in internal=true; websearch-out internal=false; AGENT_EGRESS=open | websearch-in internal=true, node never on websearch-out | as designed |

SearXNG engine health at measurement time: [["brave", "too many requests"], ["duckduckgo", "timeout"], ["google cse", "too many requests"], ["startpage", "Suspended: CAPTCHA"], ["wikidata", "access denied"]]. `agent/websearch.ts` cascades from the default engine set to single engines when it gets an empty 200, so a suspended default engine does not necessarily mean `no results`.

Service state: at measurement time the published SearXNG endpoint answered with 0 results and reported 5 suspended/unresponsive engines. `agent/websearch.ts` falls back to single engines on an empty 200, so a partially suspended engine set does not by itself mean `no results`. An earlier discovery pass saw the default set return empty 200s and Camofox log a tab-create timeout plus an automatic browser relaunch; that evidence is kept in `runs/post-5f0dd0c-20261105T121306Z/discovery-degraded-1009.json` and `runs/post-5f0dd0c-20261105T121306Z/pre-gold/` when present.

The agent container cannot name or dial a page: `web_read` takes only an opaque `sourceId`, and `/search` returns no URL at all. The direct TCP/HTTP/DNS checks are negative controls — they must fail, or the RFC 0016 isolation claim is broken. The end-to-end proof that the stack actually works is the search/read hit rate below, plus the `/prompt` smoke.

## 2. Hit rate

| Query | Text | Served | Rate | p50 | p90 |
| --- | --- | --- | --- | --- | --- |
| Q1 | Node.js 24 run TypeScript natively type stripping | 3/3 | 100.0% | 14402 ms | 14443 ms |
| Q2 | Svelte 5 runes $state documentation | 3/3 | 100.0% | 4656 ms | 14389 ms |
| Q3 | HTTP status code 429 MDN | 2/3 | 66.7% | 14438 ms | 25987 ms |
| Q4 | ISO 8601 date and time format wikipedia | 3/3 | 100.0% | 4524 ms | 14448 ms |
| Q5 | example domain illustrative examples | 3/3 | 100.0% | 4406 ms | 14445 ms |

- **search_hit_rate = 93.3%** (28/30 search attempts). A search is *served* when HTTP 200 returns at least one result.
- **read_hit_rate = 96.2%** (25/26 read attempts). A read is a hit when HTTP 200 returns non-empty text.
- **url_reach_rate = 6.7%** (1/15): a domain-matched opaque id resolved to the exact gold URL in the `/read` response. 8 URL cases had no domain-matched candidate and fell back to reading the first result (off-gold).
- **url_e2e_rate = 6.7%** (1/15): gold URL reached *and* its page text returned.
- **prompt_chain_rate = 100.0%** (3/3): `/prompt` with `web:allowed` reached `web_read` and the faux model quoted its text.
- Search latency p50/p90: 14311/14731 ms. Read latency p50/p90: 529/4674 ms.
- Refusals: {"read:500:internal": 1}

## 3. Read quality against the 5 gold URLs

Markers are exact phrases taken from an independent host-side HTML fetch of each URL, never from `web_read`. `head` markers sit inside the first 6000 visible characters; `deep` markers sit after them (verified against the Camofox full-text ceiling fetched in this run). `fidelity` = share of markers present; `completeness` = `len(text) / len(Camofox full innerText)`; `prose` = share of characters in lines with at least 8 words (a nav/boilerplate proxy); `envelope` = `untrusted`, sha256, ≤6000 chars, matching URL and title.

| URL | Target | Reached | Read OK | Fidelity | Deep fid. | Complete | Prose | Score | Usable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| U1 | https://nodejs.org/learn/typescript/run-natively | 0/3 | 3/3 | 0.0% | n/a | 50.8% | 38.4% | 0.185 | 0/3 |
| U2 | https://svelte.dev/docs/svelte/$state | 0/3 | 3/3 | 0.0% | 0.0% | 9.2% | 84.7% | 0.150 | 0/3 |
| U3 | https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429 | 0/3 | 3/3 | 0.0% | n/a | 100.0% | 54.6% | 0.332 | 0/3 |
| U4 | https://en.wikipedia.org/wiki/ISO_8601 | 1/3 | 2/3 | 20.8% | 16.7% | 3.8% | 11.1% | 0.176 | 0/3 |
| U5 | https://www.example.com/ | 0/3 | 3/3 | 0.0% | n/a | 100.0% | 57.9% | 0.337 | 0/3 |

| URL | Full page (ceiling chars) | Delivered chars | Markdown signals | Markdown preserved | Missing markers (rep 1) |
| --- | --- | --- | --- | --- | --- |
| U1 | 5352 | 2721 | 11 | yes | Running TypeScript Natively, Type stripping, --experimental-strip-types |
| U2 | 9327 | 857 | 4 | yes | $state, Deep state, $state.snapshot |
| U3 | 4391 | 6000 | 84 | yes | 429 Too Many Requests, too many requests in a given amount of time, rate limiting |
| U4 | 52508 | 35 | 0 | no | ISO 8601, Data elements and interchange formats, Calendar dates |
| U5 | 917 | 6000 | 73 | yes | This domain is for use in documentation examples without needing permission, This is not a service, avoid relying on it for testing and monitoring purposes |

- **quality_rate (usable) = 0.0%** (0/15): `read_ok && envelope_ok && fidelity >= 0.60 && quality_score >= 0.70`. Conditional on a successful read of the gold URL, mean fidelity is 62.5% and the usable rate is 0.0% (n=1).
- **mean_quality_score = 0.236**; `0.40*fidelity + 0.25*completeness + 0.15*prose + 0.20*envelope`.
- **mean_fidelity = 4.2%**, **mean_deep_fidelity = 8.3%** (deep markers only, 6 attempts).
- **truncated_rate = 46.7%**, **focus_window_rate = 42.9%** (of truncated reads). The head+focus window is meant to recover deep markers without raising the 6000-character cap.
- **markdown_preservation_rate = 86.7%**. `web_read` returns Markdown-like semantic blocks: `agent/websearch.ts` renders headings, lists, code and tables in the browser, caps that text at 60000 characters, then selects a `MAX_READ_CHARS = 6000` head+focus window.

## 4. Query intent quality against the 5 gold queries

The tool does not return URLs in search results, so relevance is judged on `domain`, `title` and `snippet` by the pre-registered rubric in `gold.json`: allowlisted domains, or at least two topical terms; excluded domains and excluded title/URL patterns are judged irrelevant first. Per-result judgments are stored in `metrics.json` and `raw/*.json` for human re-judging.

| Query | Intent | P@5 | P@8 | Top-1 relevant | Any relevant | MRR | Mean results |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Q1 | Find the official documentation for running TypeScript natively in Nod | 40.0% | 50.0% | 100.0% | 100.0% | 1.000 | 8.0 |
| Q2 | Find the official Svelte 5 documentation page for the $state rune. | 60.0% | 75.0% | 100.0% | 100.0% | 1.000 | 8.0 |
| Q3 | Find the canonical HTTP 429 Too Many Requests reference page and its s | 0.0% | 0.0% | 0.0% | 0.0% | 0.000 | 5.3333 |
| Q4 | Find the encyclopedic reference for the ISO 8601 date/time representat | 26.7% | 20.8% | 0.0% | 66.7% | 0.333 | 8.0 |
| Q5 | Find the authoritative explanation of reserved example domains and the | 0.0% | 0.0% | 0.0% | 0.0% | 0.000 | 8.0 |

- **query_intent_rate (mean P@5) = 25.3%**; **top1_relevance_rate = 40.0%**; **any_relevant_rate = 53.3%**; **MRR = 0.467**.

## 5. Findings

- SearXNG and Camofox answered from the web-search node, but the agent container could not reach either directly: the per-user network exposes only the node, as RFC 0016 requires.
- `/search` returns no URL (only `sourceId`, `domain`, `title`, `snippet`): a specific gold URL is reachable only by reading a domain-matched id and comparing the URL revealed in `/read`. It resolved in 6.7% of URL cases.
- Queries were served 93.3% of the time and pages were extracted 96.2% of attempted reads; the `/prompt` chain reached `web_read` in 3/3 attempts.
- Search results matched the pre-registered intent with P@5 25.3% and top-1 relevance 40.0%.
- Of 15 URL cases, 1 delivered the gold page; conditional on delivery, mean fidelity is 62.5% and 0.0% are usable. Non-deliveries: u-U1-r1 (read HTTP 200, gold reached False), u-U2-r1 (read HTTP 200, gold reached False), u-U3-r1 (read HTTP 200, gold reached False), u-U4-r1 (read HTTP 200, gold reached False), u-U5-r1 (read HTTP 200, gold reached False), u-U1-r2 (read HTTP 200, gold reached False), u-U2-r2 (read HTTP 200, gold reached False), u-U3-r2 (read HTTP 200, gold reached False), u-U4-r2 (read HTTP None, gold reached False), u-U5-r2 (read HTTP 200, gold reached False), u-U1-r3 (read HTTP 200, gold reached False), u-U2-r3 (read HTTP 200, gold reached False), u-U3-r3 (read HTTP 200, gold reached False), u-U5-r3 (read HTTP 200, gold reached False). A 502 `read_unavailable` is an upstream Camofox failure, not a search miss.
- `web_read` delivers Markdown-like semantic blocks in a 6000-character head+focus window (markdown structure in 86.7% of reads). Long pages are explicitly truncated: truncated_rate 46.7%, focus_window_rate 42.9%; mean completeness 52.8%, deep-marker fidelity 8.3% versus head-marker fidelity 5.0%.
- Lowest-scoring URLs: U4 (0.000, 0 chars, 8 missing markers), U4 (0.000, 35 chars, 8 missing markers).
- Named refusals observed: read:500:internal ×1.

## 6. Limits and threats to validity

- The live index is volatile: results depend on SearXNG engine health, time and locale. The run stores every raw response so the judgement can be re-checked, but repeating it later can legitimately produce different numbers.
- This stack runs the deterministic faux provider. The scored matrix drives the tool transport from inside the agent container (same headers as `web_search`/`web_read`); the model-in-the-loop path is covered only by the three `/prompt` smoke attempts, whose query is fixed by the faux script.
- `AGENT_EGRESS` was `open` in this stack. Direct isolation of SearXNG/Camofox was measured, not assumed; with `off` the per-user network is also `--internal`.
- Relevance is a deterministic rubric, not a human panel: domain allowlists and two-term topical matching can credit a blog that a human would reject, or reject an unlisted but authoritative domain.
- `prose_ratio` is a proxy for boilerplate; code-heavy documentation pages score lower by construction.
- Markdown preservation is scored on structure signals in the returned text, not on a diff against a canonical Markdown conversion; the browser renders semantic blocks as Markdown-like text without a library.
- 30 cases only. The sample measures one stack on one day, not a fleet or a long-running SLA.

## 7. Reproduction and artifacts

```bash
cd e2e-test/websearch-eval
python3 harness.py discover                       # optional pre-gold probe
python3 harness.py run --repeats 3 --run-id NEW-ID
python3 analyze.py --run-id post-5f0dd0c-20261105T121306Z
```

- `runs/post-5f0dd0c-20261105T121306Z/manifest.json` — environment fingerprint
- `runs/post-5f0dd0c-20261105T121306Z/connectivity.json` — host, node and agent reachability probes
- `runs/post-5f0dd0c-20261105T121306Z/references/` — independent HTML fetch, cleaned text, Camofox full-text ceiling, marker offsets
- `runs/post-5f0dd0c-20261105T121306Z/attempts.jsonl` + `raw/*.json` — every attempt, full HTTP bodies and page text
- `runs/post-5f0dd0c-20261105T121306Z/prompt-smoke.json` — `/prompt` replies through Caddy
- `runs/post-5f0dd0c-20261105T121306Z/pre-gold/` + `discovery-degraded-1009.json` — pre-registration evidence and the observed upstream degradation
- `metrics.json` — machine-readable scores; `REPORT.md` — this report
