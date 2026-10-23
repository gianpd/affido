# RFC 0001 — Provider SDKs as `optionalDependencies` in `@earendil-works/pi-ai`

| Field | Value |
|---|---|
| Status | Draft |
| Author | Affido maintainers |
| Date | 2026-10-16 |
| Target | `packages/ai` (`@earendil-works/pi-ai`) in the pi monorepo; consumer change in `affido/agent` |
| Related | "Bundling and Tree Shaking" in `packages/ai/README.md` |

## 1. Summary

`@earendil-works/pi-ai` declares five provider SDKs as regular `dependencies`. Every
consumer installs all of them even when it uses one provider. Move the five SDKs to
`optionalDependencies` and let consumers opt out of them with `npm ci --omit=optional`
(a setting that can be pinned in `.npmrc`). The SDKs stay installed by default, so this
is backward compatible; the slimming is a deliberate, deterministic flag.

This is the "deterministic" variant of the earlier proposal: no peer-dependency
resolution, no implicit installs, no bundler required. One flag selects the same set of
packages on every machine.

## 2. Motivation

### 2.1 The install-cost problem

Measured on `affido/agent` (Node 24, npm 11.6.2). `node_modules` is
139 MB. Traversing `package-lock.json` and summing the subtrees of the provider SDKs:

| SDK | Subtree | Packages |
|---|---:|---:|
| `openai` | 27.9 MB | 1 |
| `@google/genai` | 30.0 MB | 42 |
| `@aws-sdk/client-bedrock-runtime` | 17.4 MB | 27 |
| `@anthropic-ai/sdk` | 16.9 MB | 7 |
| `@smithy/node-http-handler` | 8.2 MB | 4 |
| **Union** | **92.3 MB** | **77** |

A single-provider deployment pays for all five. The number is not theoretical: the
Docker image for `agent-a`/`agent-b`/`agent-c` installs these layers with
`npm ci --omit=dev --ignore-scripts` (`agent/Dockerfile`), then never imports the
unused SDKs.

### 2.2 Runtime is already lazy; disk is not

pi-ai already isolates SDK loading. Provider factories import a model catalog and a
`api/*.lazy.js` wrapper; the wrapper defers the real SDK import to the first request of a
matching model (`lazyApi(() => import("./openai-completions.js"))`). Measured process
footprint:

| Import | RSS | heap |
|---|---:|---:|
| empty Node | 39.5 MB | 3.6 MB |
| `.../pi-ai/models` | 43.2 MB | 4.4 MB |
| `.../providers/openrouter` instantiated | 46.2 MB | 5.2 MB |
| `openai` loaded | +27 MB | +7 MB |
| `@anthropic-ai/sdk` loaded | +17 MB | +3 MB |
| `@google/genai` loaded | +38 MB | +7 MB |
| `@aws-sdk/client-bedrock-runtime` loaded | +28 MB | +6 MB |

Instantiating a provider does not load any SDK. With one provider, only that provider's
SDK enters memory, and only on the first model call. The RAM win from pruning is
therefore small; the disk/install win is large. This RFC targets the disk win and keeps
runtime behavior unchanged.

### 2.3 `typebox` is not in scope

`typebox` (6.2 MB) is required by `@earendil-works/chord`, `@earendil-works/pi-durable`,
and `@earendil-works/agent` for tool schemas. It is not a provider SDK and cannot be
removed by changing `packages/ai`. It stays a regular dependency.

### 2.4 OpenRouter uses two SDKs

`openrouterProvider()` registers both `anthropic-messages` (`@anthropic-ai/sdk`) and
`openai-completions` (`openai`). The catalog has 381 `openai-completions` models and 15
`anthropic-messages` models. A deployment that pins a non-Anthropic model never loads
`@anthropic-ai/sdk`, so it can omit that package. A deployment that pins a Claude model
loads `@anthropic-ai/sdk` and can omit `openai`.

## 3. Goals

- Remove unused provider SDKs from installs that opt in with `omit=optional`.
- Keep the default `npm install @earendil-works/pi-ai` behavior unchanged (all providers
  work out of the box).
- Keep pi's own CI green and the standalone coding-agent install complete.
- Fail loudly and actionably when an omitted SDK is required at runtime.

## 4. Non-goals

- Removing `typebox` or any non-provider dependency.
- Reducing steady-state RAM; pi-ai is already lazy.
- Changing provider APIs, model catalogs, or the `exports` map.
- Building a per-provider package split (tracked separately as a possible follow-up).
- Replacing the `openai` SDK with a `fetch` implementation.

## 5. Proposal

### 5.1 Upstream: `packages/ai/package.json`

Move the five SDKs from `dependencies` to `optionalDependencies`. Keep exact pinned
versions (required by `scripts/check-pinned-deps.mjs`, which also scans
`optionalDependencies`).

```jsonc
{
  "dependencies": {
    "@earendil-works/pi-telemetry": "1.3.0",
    "http-proxy-agent": "9.1.0",
    "https-proxy-agent": "9.1.0",
    "partial-json": "0.1.7",
    "typebox": "1.3.27"
  },
  "optionalDependencies": {
    "@anthropic-ai/sdk": "0.129.0",
    "@aws-sdk/client-bedrock-runtime": "3.1127.0",
    "@google/genai": "2.21.0",
    "@smithy/node-http-handler": "4.12.1",
    "openai": "7.19.0"
  }
}
```

`scripts/check-runtime-deps.mjs` already accepts names declared in
`dependencies`, `optionalDependencies`, or `peerDependencies`, so the "undeclared runtime
import" check stays green. `scripts/check-pinned-deps.mjs` scans
`optionalDependencies`, so versions stay exact.

### 5.2 Runtime error when an SDK is omitted

With `omit=optional`, the lazy `import("./openai-completions.js")` rejects with
`ERR_MODULE_NOT_FOUND`. Today that surfaces through `lazyStream` as a raw platform
message. Add an actionable hint at the lazy boundary.

Add a shared helper used by every `api/*.lazy.ts`:

```ts
// packages/ai/src/api/lazy.ts
export function loadOptionalModule<T>(
  load: () => Promise<T>,
  packageName: string,
): Promise<T> {
  return load().catch((error: unknown) => {
    if (isModuleNotFound(error, packageName)) {
      throw new Error(
        `This provider requires the optional dependency "${packageName}". ` +
          `Install it with: npm install ${packageName}`,
      );
    }
    throw error;
  });
}
```

Wire each lazy wrapper with its SDK(s):

| Lazy wrapper | `optionalDependencies` |
|---|---|
| `openai-completions.lazy.ts`, `openai-responses.lazy.ts`, `openai-decisions.lazy.ts`, `openrouter-images.lazy.ts`, `azure-openai-responses.lazy.ts` | `openai` |
| `anthropic-messages.lazy.ts` | `@anthropic-ai/sdk` |
| `google-generative-ai.lazy.ts`, `google-vertex.lazy.ts` | `@google/genai` |
| `bedrock-converse-stream.lazy.ts` | `@aws-sdk/client-bedrock-runtime`, `@smithy/node-http-handler` |

The error still emerges as an assistant error event via `lazyStream`; only the message
changes.

### 5.3 Docs

Update the "Installation" and "Bundling and Tree Shaking" sections of
`packages/ai/README.md`:

- State that provider SDKs are `optionalDependencies`, installed by default.
- Show the opt-in slim flow:
  `npm ci --omit=optional` plus an explicit `npm install openai` (or the SDK for the
  selected provider).
- List which package each provider factory needs.

### 5.4 Consumer: `affido/agent`

1. Add the SDK for the selected provider as a direct dependency. For OpenRouter with an
   `openai-completions` model:

```jsonc
// agent/package.json
"dependencies": {
  "@earendil-works/chord": "1.3.0",
  "@earendil-works/pi-ai": "1.3.0",
  "@earendil-works/pi-durable": "1.3.0",
  "openai": "7.19.0"
}
```

Direct dependencies are installed even under `--omit=optional`, so the selected SDK is
always present. If the deployment uses the `faux` provider only, add no SDK.

2. Pin the flag so local installs and CI match the image. Add `agent/.npmrc`:

```ini
omit=optional
```

and pass the flag explicitly in the Dockerfile (flags and `.npmrc` agree):

```dockerfile
RUN npm ci --omit=dev --omit=optional --ignore-scripts
```

Note: `agent/.dockerignore` excludes `node_modules`; the Dockerfile copies only
`package.json` and `package-lock.json`, so the explicit flag is what makes the image
deterministic. The `.npmrc` file covers local development.

3. Regenerate `agent/package-lock.json` with
   `npm install --package-lock-only --ignore-scripts` after the `package.json` change.

### 5.5 Rollout

The consumer can only benefit after a published release of `@earendil-works/pi-ai`
contains the change.

- Phase 1 (upstream): change `packages/ai/package.json`, add 5.2, update docs, run the
  pi checks, publish.
- Phase 2 (consumer): bump the pinned `@earendil-works/pi-ai` version, add the SDK
  dependency and `.npmrc`, regenerate the lockfile.
- Interim (before the release): depend on a locally built `@earendil-works/pi-ai` via
  `file:` from the pi checkout, or apply the `package.json` change with `patch-package`
  in `agent/`. This is explicitly temporary and must be removed at Phase 2.

## 6. Why `optionalDependencies` is deterministic

- npm installs `optionalDependencies` by default. Existing consumers do not change
  behavior; no functionality silently disappears.
- `npm ci --omit=optional` skips exactly the optional set on every platform. No peer
  resolution, no "npm may or may not fetch it" ambiguity.
- `optionalDependencies` also tolerate install failure without aborting the install. For
  pure-JS provider SDKs this is neutral; for the AWS SDK subtree it is a mild bonus.
- The lockfile still records the packages. `npm ci` resolves from the lock and then skips
  optional entries; `npm install` without the flag installs the same lock.

Contrast with `peerDependencies` + `peerDependenciesMeta.optional`: peers are not
installed by default, which would break existing consumers unless they add every SDK
they might use. That is more implicit and is why this RFC prefers `optionalDependencies`.

## 7. Impact on pi's own tooling

| Check / script | Impact |
|---|---|
| `scripts/check-runtime-deps.mjs` | Unaffected; accepts `optionalDependencies`. |
| `scripts/check-pinned-deps.mjs` | Unaffected; scans `optionalDependencies` for exact versions. |
| `scripts/check-browser-smoke.mjs` | Works only if the optional SDKs are installed. It builds a selective-provider bundle and asserts exactly `@anthropic-ai/sdk` is present (lines 128-140). Moving the manifest section does not change bundler resolution, but the check fails if run under `omit=optional`. |
| `scripts/generate-coding-agent-install-lock.mjs` | Unaffected; `packageDependencies()` merges `dependencies` and `optionalDependencies`, so the coding-agent install lock keeps every SDK. |
| `npm run build` / `build:offline` | Unaffected; `tsc` does not resolve optional deps at runtime. Types for the optional SDKs come from `devDependencies` or the root install. |

The root install does not set `omit=optional`, so the monorepo and local tests keep all
provider SDKs. Only the container opts out.

## 8. Impact on the standalone coding-agent install

`packages/coding-agent/install-lock/` is generated by merging `dependencies` and
`optionalDependencies`. It will keep all provider SDKs, so the standalone CLI stays
full-featured.

Guardrail: `npm run check` (both `check:install-lock:coding-agent` and
`check:browser-smoke`) requires the optional SDKs to be installed. The generation and
check commands must run with the default omit setting. Recommend documenting this and,
if cheap, asserting that the resolved coding-agent lock contains every optional SDK.

## 9. Testing and verification

Upstream (pi monorepo):

```
npm run check          # biome, pinned-deps, runtime-deps, ts, install-lock, browser-smoke
./test.sh              # non-e2e tests
```

Add a unit test that simulates a missing SDK (mock the dynamic import to throw
`ERR_MODULE_NOT_FOUND`) and asserts the actionable message. Exercise each lazy wrapper.

Consumer (`affido`):

```
cd agent
npm ci --omit=dev --omit=optional --ignore-scripts
du -sh node_modules                         # expect ~75 MB with openai, ~47 MB without
node -e "import('openai')"                  # must succeed
node -e "import('@google/genai').catch(e => process.exit(e.code === 'ERR_MODULE_NOT_FOUND' ? 0 : 1))"
```

Functional checks:

- `faux` provider: agent starts, `/prompt` runs, no SDK loaded.
- OpenRouter with an `openai-completions` model: first request loads `openai`, succeeds.
- A provider whose SDK was omitted: first request returns an actionable error, not a
  crash.

Size scenarios:

| Kept SDKs | Approx. `node_modules` |
|---|---:|
| all five (today) | 139 MB |
| `openai` only | ~75 MB |
| `@anthropic-ai/sdk` only | ~64 MB |
| none (`faux`, or fetch-based API) | ~47 MB |

## 10. Risks and mitigations

**Global `omit=optional` is coarse.** It also skips unrelated optional dependencies of
the tree (for example `ws` native addons `bufferutil`/`utf-8-validate`, or platform
packages). On Linux these fall back to JS and are safe to omit. Mitigation: verify the
agent's runtime dependencies have no optional deps that are required on Linux; if a
conflict appears, switch those packages to direct dependencies or keep them installed.

**Silent omission for a needed provider.** A deployment that uses two providers but adds
only one SDK would fail at runtime. Mitigation: the actionable error in 5.2, plus an
explicit SDK dependency in `agent/package.json` for the selected provider.

**Interim `patch-package` drift.** The temporary patch can diverge from upstream.
Mitigation: pin the pi version, and treat the patch as a hard removal item in Phase 2.

**Lockfile churn.** `optionalDependencies` move changes `package-lock.json` entries.
Mitigation: follow `AGENTS.md` — regenerate with
`npm install --package-lock-only --ignore-scripts`, keep exact versions, review the lock
diff.

## 11. Alternatives considered

- **`peerDependencies` + optional meta.** More implicit: peers are not installed by
  default, so existing consumers could break. Rejected for this RFC.
- **Per-provider packages** (`@earendil-works/pi-ai-provider-*`). Cleanest long-term, but
  a publish/exports/versioning refactor. Deferred.
- **Bundling with esbuild code splitting.** Does not remove packages from an unbundled
  Node install, and esbuild follows reachable dynamic imports, so unused SDKs still get
  chunked. Not sufficient alone.
- **`fetch`-based API implementation to drop `openai` entirely.** Larger effort; could
  follow if the `openai` subtree (27.9 MB) must go.
- **`overrides` to remove dependencies.** npm `overrides` changes versions, not the
  dependency set. Not viable.

## 12. Open questions

1. Should the actionable error live in `lazyApi` as a `requires` option, or in each
   `*.lazy.ts` wrapper? (Leaning to a helper per wrapper for explicit SDK lists.)
2. Does the Browser/Cloudflare smoke build need any adjustment if the SDKs are optional?
   Expected no, to be confirmed by `npm run check:browser-smoke`.
3. Should `affido/agent` ship two images (faux-only vs real provider), or
   one image with `openai` plus the `.npmrc` flag?

## 13. Decision

Pending review. Recommended path: adopt 5.1–5.4, implement Phase 1 upstream, then Phase 2
in `affido/agent`. Expected outcome: `node_modules` from 139 MB to ~75 MB
(OpenRouter, `openai` kept) with no RAM change and no default-install behavior change.
