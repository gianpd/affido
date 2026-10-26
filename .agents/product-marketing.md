# Product Marketing Context

*Last updated: 2026-03-19 (V1 auto-drafted from the repository; TBD = needs maintainer input)*

## Product Overview

**One-liner:** Self-hosted AI agents you can entrust: sandboxed by default, powers granted one skill at a time, every act traced and on the record.

**What it does:** Affido gives each user one isolated agent sandbox that the platform provisions on demand. Users upload documents, chat with their agent, and get answers whose every step — tool calls, failures, cost — is captured in a durable trace. With strict citations on, an answer is only published through a deterministic gate that re-verifies every quote against the stored documents (document, version, line range, exact span, sha256). The model layer is provider-agnostic: each user picks a provider from a curated catalog or registers any OpenAI-compatible endpoint and brings their own key; the default stack runs a keyless scripted provider, so no vendor lock-in and no mandatory API key.

**Product category:** Self-hosted, provider-agnostic AI agent platform / trusted agent infrastructure. The "shelf" customers search for: "self-hosted AI agent platform", "chat with documents self-hosted", "sandboxed agents", "AI agent with audit trail", "self-hosted AI bring your own model".

**Product type:** Open-source self-hosted software (Apache-2.0) with a web dashboard. Research-stage project, not yet a commercial SaaS. Enterprise extensions planned under `ee/` with a separate license (currently only a statement in the README — no `ee/` directory yet).

**Business model:** None in place yet. TBD: open-core (Apache-2.0 core + paid enterprise extensions) is the stated direction. No pricing exists.

## Target Audience

**Target companies:** TBD — likely (a) engineering/platform teams who must offer AI features to internal or external users without a vendor holding the data, and (b) security/compliance-conscious organizations (legal, finance, public sector, ISO-style environments) that need provable attribution and auditability. Needs validation.

**Decision-makers:**
- Platform/infrastructure engineers (deploy it, own the containment story)
- CTOs / engineering leads (data sovereignty: "data stays in your control plane")
- Compliance or quality managers (trace, citations gate, audit)
- End users of the dashboard (knowledge workers chatting with documents)

**Primary use case:** Give every user a private, document-grounded AI agent that runs on infrastructure you control, where nothing the agent did is ever invisible.

**Jobs to be done:**
- "Let my users ask questions over their own document corpus, with quotes I can verify against the source files."
- "Run per-user agents without N always-on containers eating RAM, and without agents reaching the internet or each other."
- "Produce an audit trail of what the agent did — steps, tool calls, cost — without building it myself."

**Use cases:**
- Chat with an uploaded corpus (PDFs, text) with strict-citation answers (`citations: "required"`)
- Generate deliverables (e.g. `.docx` via the `md-to-docx` skill) as downloadable artifacts
- Inspect past conversations and decision graphs per user (`/dashboard/traces`)
- Each user brings their own model key (BYOK: DeepSeek, custom OpenAI-compatible endpoints)

## Personas

| Persona | Cares about | Challenge | Value we promise |
|---------|-------------|-----------|------------------|
| Platform engineer (deployer) | Containment, no host ports, egress walls, predictable ops | DIY agent deploys leak: agents with internet + host access, N containers always on | One manager provisions/stops/evicts per-user sandboxes; internal networks + iptables wall by default |
| Compliance/quality owner | Auditability, provable attribution | LLM answers are unauditable black boxes | Every question leaves a durable trace; citation gate verifies every quote against stored documents |
| CTO / data owner | Data sovereignty | SaaS vendors hold documents and prompts | Self-hosted: data stays in your control plane; user keys never touch disk in the agent |
| End user (knowledge worker) | Useful answers over *their* documents, artifacts they can download | Pasting documents into a chat tool repeatedly; untraceable answers | Private agent with their corpus, durable conversations, verified citations, downloadable deliverables |

## Problems & Pain Points

**Core problem:** Organizations want to hand out AI agents to many users, but a shared or SaaS agent means data leaves their control and agent behavior is unauditable — while self-rolled agents are dangerous (full tool access, internet egress) and expensive to run N of.

**Why alternatives fall short:**
- SaaS "chat with docs" (NotebookLM, ChatGPT Teams, Perplexity Enterprise): documents and prompts leave your perimeter; no per-user isolation; no verifiable trace you can audit.
- Self-hosted chat UIs (LibreChat, Open WebUI, AnythingLLM): multi-user chat with BYOK, but the "agent" is a model call with tools at best — no per-user sandbox, no durable per-user sessions, no capability manifests, no citation gate, no decision traces.
- DIY (own agent + Docker + RAG pipeline): you end up rebuilding isolation, eviction, resume, traces, and citation verification — each one a security or durability hole while you do.

**What it costs them:** Data exposure risk; unexplainable answers that can't be defended in an audit or to a client; ops cost of N always-on containers; engineering months rebuilding what the control plane already does.

**Emotional tension:** "I'd be liable for what this thing does, and I can't see what it did." The trust deficit: useful enough to want, opaque enough to fear.

## Competitive Landscape

**Direct:**
- *LibreChat / Open WebUI / AnythingLLM* — self-hosted, multi-user, BYOK chat over documents. Fall short: no per-user sandboxed agent (shared process), no durable per-user session with pause/resume/evict, no deterministic citation gate, no decision traces. Affido is agent infrastructure, not a chat UI over one process.
- *Onyx (Danswer)* — self-hosted enterprise search + answers. Falls short: retrieval-centric, not an agent with a workspace, skills, and artifacts; no per-user sandbox; no attribution gate with exact-span verification.

**Secondary:**
- *NotebookLM / Perplexity Enterprise / Glean* — same core need (grounded answers over private docs) but managed: data leaves your control, no self-hosting, no per-user container isolation, no installable capability model.

**Indirect:**
- *DIY stack* (LangChain/agent framework + Docker + vector DB) — full control but you own every failure mode Affido already gates: egress walls, path confinement, manifest-verified skills, crash-safe sessions, citation verification.
- *Just give users ChatGPT accounts* — the habit to displace: zero audit trail, data in a vendor's hands, no shared corpus governance.

## Differentiation

**Key differentiators:**
- **Bounded:** per-user container created on demand; `--internal` network with no NAT, per-bridge iptables INPUT DROP host wall (fail-closed); no host ports; workspace confined to a per-user volume. Containment is asserted by e2e security tests, not prose.
- **Granted:** the agent starts powerless; capabilities arrive as manifest-verified (sha256) skills installed file-by-file; the runtime image ships **no installer** (`npm`/`npx`/`corepack` deleted), so new powers cannot appear from inside.
- **Durable:** conversations are SQLite on per-user volumes — pause, `docker stop`, eviction, reprovision: the session resumes, runs included. `POST /prompt` is idempotent by `requestId`.
- **On the record:** every question produces a full trace (steps, tool calls, failures, cost, decision graph); with `citations: "required"` answers publish only through a deterministic gate that re-verifies each quote against stored text (document, version, line range, exact span, sha256) — and citations survive restarts.
- **Resource-honest scale:** N users = N sandboxes, RAM only for active users (measured: 50 simultaneous ≈ 3.1 GiB; idle containers fully stopped and restarted on demand in ~440 ms).
- **Honesty box:** the docs state the gate guarantees *attribution, not truth* — no overclaiming. This candor is itself a differentiator.
- **Provider-agnostic, per-user:** any provider through a curated catalog or a custom OpenAI-compatible endpoint, chosen per user (BYOK); keys are AES-256-GCM-encrypted in Postgres, delivered to agent memory only, never to container env, filesystem, or logs. The keyless faux provider is the zero-secret default — the platform is neutral about whose models run inside it.

**How we do it differently:** Isolation, capability, durability, and attribution are enforced by code and verified by `./verify.sh` (e2e suites, containment negatives, BYOK chain, restart-survival) — not by policy documents or prompt instructions.

**Why that's better:** Deployers can demonstrate, not assert: every claim in the pitch maps to a test in the gate.

**Why customers choose us:** TBD — no customers yet. Expected: "I need the data to stay here, and I need to show an auditor exactly what the agent did and where each quote came from."

## Objections

| Objection | Response |
|-----------|----------|
| "It builds on an experimental library (`pi-durable` 1.3.0)." | True and stated openly. The pin is exact, upgrades are treated as API reviews, and restart-survival is proven in the e2e gate on every run. |
| "The citation gate doesn't guarantee the answer is true." | Correct — it guarantees *attribution, not truth*: every cited span provably exists in your documents. The model proposes, the code verifies, the human decides. That is the intended contract, not a defect. |
| "Isolation claims are hard to trust." | Each claim is a negative test in `e2e-test/security.sh` / `verify.sh`: host listeners unreachable from a sandbox, path escapes refused, `X-Sandbox-Endpoint` stripping, symlink caps, egress walls. |
| "Egress is off by default — so no real models?" | BYOK with an internet provider needs `AGENT_EGRESS=open` (opt-in; the host wall stays). The keyless faux provider is the zero-secret default for demos and tests. |
| "Single-host compose — is this production-ready?" | It is research-stage. Scale story is one host today (L1 eviction makes N users cheap); k8s is not claimed. Don't oversell it. |

**Anti-persona:** Teams wanting a zero-ops hosted SaaS with no infrastructure of their own; users who want a maximally autonomous internet-connected agent out of the box (egress-off default and no installer are the opposite of that product); enterprises needing SOC2/ISO certifications or a vendor contract before adoption.

## Switching Dynamics

**Push:** Pasting confidential documents into a vendor's chat box; unauditable agent output; DIY agents with dangerous defaults (internet + host access, installable packages); N always-on containers burning RAM.

**Pull:** One `./dev.sh up` demo with no API key; verified quotes with sha256; per-user isolation enforced by test; sessions that survive restarts; BYOK without keys ever hitting disk.

**Habit:** "Paste the doc into ChatGPT/Claude and hope" — fast, familiar, already in everyone's muscle memory; or an existing self-hosted chat UI that's "good enough".

**Anxiety:** Self-hosting burden (Docker, Postgres, Caddy, updates); experimental dependency under the hood; "can I really trust the isolation claims?" (answer: run `./verify.sh` yourself); BYOK friction (users must obtain a provider key for real models).

## Customer Language

**How they describe the problem:**
- TBD — no sales conversations on record. Expected shapes (to validate): "I can't put client documents in someone else's cloud." / "If the agent gets it wrong, I have to show where it went wrong." / "I don't want one user's agent touching another's files."

**How they describe us:**
- TBD — no users yet.

**Words to use:** entrust, on the record, bounded, granted, durable, sandbox, per-user, self-hosted, provider-agnostic, model-agnostic, bring your own model, bring your own key, verifiable citations, trace, attribution (not truth), control plane, skills, artifacts, corpus.

**Words to avoid:** "hallucination-proof", "100% secure", "guarantees truth", "unlimited autonomy", "set-and-forget", vendor-lock-in-free marketing fluff. Never claim the gate makes answers correct.

**Glossary:**
| Term | Meaning |
|------|---------|
| Sandbox | The per-user container (agent + workspace volume + session DB) created by the manager |
| Manager / sandbox-manager | Python control-plane service that provisions, stops, evicts sandboxes |
| Harness | `DurableHarness`: the durable conversation lifecycle inside a sandbox |
| Trace | The record of everything the agent did for a question (entries, tool calls, decisions, usage) |
| Citation gate | The deterministic publisher that verifies every cited span against stored documents before an answer goes out |
| Corpus | The user's staged documents (raw bytes + derived text) the agent greps and reads |
| Skill | A manifest-verified capability bundle (e.g. `md-to-docx`) installed into a sandbox |
| Artifact | A deliverable the agent writes (e.g. `.docx`), listed and downloadable with sha256 |
| BYOK | Bring your own key: per-user model provider keys, encrypted in Postgres, delivered to agent memory only |
| Faux provider | The keyless scripted default model provider for demos and tests |
| L0/L1 eviction | In-process pause (SQLite closed) / full container stop with resume from the volume |

## Brand Voice

**Tone:** Technical, sober, direct. Sober-to-grim; no hype. Honesty box over marketing gloss.

**Style:** Short declarative sentences. Concrete mechanisms over adjectives ("iptables INPUT DROP host wall", not "military-grade security"). State limits explicitly (attribution not truth; single-host scale; experimental dependency). English prose; Italian naming heritage is embraced (Affido = "I entrust").

**Personality:** Accountable, precise, restrained, verifiable, candid. The brand says "prove it" — and then proves it with a test gate.

(Visual identity is normative in RFC 0011: dusk-lit pixel-art poster on newsprint, oxblood/cream/amber, zero border radius, flat color, Geist + Geist Mono + Jersey 10. Marketing surfaces must match.)

## Proof Points

**Metrics:**
- ~440 ms measured resume from a full container stop (L1); 2–3 ms in-process resume (L0)
- 50 simultaneous users ≈ 3.1 GiB RAM; eviction of 40 containers ≈ 5 s; restart of 40 ≈ 7 s (RFC 0002, measured)
- Citation gate: per-run used/reported/exact rates and gate friction, measured from the trace alone (`/inspect?report=citations`)
- One published port (`:18080`); zero model secrets required for the default stack

**Customers:** None yet (research-stage). TBD.

**Testimonials:** None yet. TBD.

**Value themes:**
| Theme | Proof |
|-------|-------|
| Containment is real, not claimed | `e2e-test/security.sh` + `verify-sandbox.sh` negatives: no host listeners from a sandbox, no path escapes, endpoint header stripping |
| Nothing is lost | Restart-survival proven in the e2e gate every run; idempotent prompts by `requestId`; conversations resume with full context after eviction |
| Every quote checkable | Citation gate re-verifies spans (sha256, line range) against stored text; re-verification survives container restarts |
| Powers are deliberate | Skills are manifest-hashed; `npm`/`npx`/`corepack` deleted from the image (asserted by `verify.sh`) |
| Cheap at N users | L1 eviction measurements above; control plane only: caddy + oltp + manager in `docker compose ps` |

## Goals

**Business goal:** TBD — project is research-stage. Inferred: validate the "entrustable self-hosted agent" thesis, build an adopter/contributor base for the Apache-2.0 core before any commercial layer.

**Conversion action:** Clone the repo and run the 5-minute quickstart (`./dev.sh up`, no API key) — then bring a real key via BYOK. Secondary: star/fork/contribute.

**Current metrics:** None on record. TBD.
