# Feature map — what the affido UI exposes and how to prove each piece

The driver is `.pi/skills/verify-affido-ui/drive.mjs` (Playwright chromium against `http://localhost:5173`, real stack behind it). Every proof = drive the user path + read the screenshots + check `facts.json`. One entry point per feature is never enough when this map lists others.

| Feature | Route(s) | Scenario | File |
|---|---|---|---|
| Auth (signup/signin/signout, password reset) | `/login`, `/login/forgot`, `/login/reset`, `/logout` | `signup`, `login`, `logout` | [auth.md](auth.md) |
| Chat with the sandbox agent | `/dashboard/chat`, `POST /api/chat` | `chat` | [chat.md](chat.md) |
| Documents (corpus files) | `/dashboard/documents` | `documents` | [documents.md](documents.md) |
| Skills marketplace | `/dashboard/skills`, `/api/marketplace/*` | `skills` | [skills-marketplace.md](skills-marketplace.md) |
| Trace history | `/dashboard/traces`, `/dashboard/traces/[id]` | `traces` | [traces.md](traces.md) |
| Uploads (workspace files) | `/dashboard/uploads` | `uploads` | [uploads.md](uploads.md) |

Shared selectors that survive refactors: sidebar links by role `link` + title (`Chat`, `Documents`, `Corpus`, `Uploads`, `Skills`, `Traces`), the composer by placeholder `Ask your agent…`, send by accessible name `Send message`. If a selector breaks, read the page source under `frontend/src/routes/…` and update both the driver and the feature file in the same change.
