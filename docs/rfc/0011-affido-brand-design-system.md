# RFC 0011 — Affido brand design system for the dashboard and UI

| Field | Value |
|---|---|
| Status | Mandatory (normative) |
| Author | Affido maintainers |
| Date | 2026-10-23 |
| Target | `frontend/` (all routes and components), `frontend/src/routes/layout.css`, `frontend/static/` |
| Related | `../pi-durable-containers/landing/styles.css`, `../pi-durable-containers/landing/index.html`, `../pi-durable-containers/landing/web_design_style.md`, `frontend/README.md` |

## 1. Summary

The marketing landing (`pi-durable-containers/landing/`) defines what Affido
looks like: a dusk-lit pixel-art poster on newsprint. The dashboard currently
uses a Perplexity-inspired teal theme, which is unrelated to that brand.

This RFC makes the landing palette, type and geometry **normative for every
screen in `frontend/`**. It is not a redesign proposal. It is the CSS contract:

- `frontend/src/routes/layout.css` carries the tokens and the shared recipes.
- `frontend/static/` carries the brand art, copied from the landing.
- This document explains the rules and the mapping. When a value changes, the
  landing stylesheet, `layout.css` and this document change together.

Concretely, a new dashboard screen is correct when it reads as a page of the
same product as `landing/index.html`: oxblood field chrome, cream type, amber
accents, paper content surfaces, and hard 4px-notched frames with no rounded
corners.

## 2. Sources of truth

| Rank | File | What it decides |
|---|---|---|
| 1 | `frontend/src/routes/layout.css` | The shipped CSS values (tokens, radius, base rules) |
| 2 | this document | Why the values exist, what each token means, what is forbidden |
| 3 | `landing/styles.css` | Original sampled palette and component recipes |
| 4 | `landing/web_design_style.md` | General Pixel Dusk technique reference (older palette; do not take hexes from it) |

Rule: **no hex literal outside `layout.css`.** If a screen needs a colour that
is not mapped, add a token here and in `layout.css`; do not inline `#RRGGBB` in
a Svelte file. The only exceptions are SVG artwork attributes (illustration,
not theme) and the `<meta name="theme-color">` value in `app.html`, which the
browser reads before CSS exists.

## 3. Non-negotiables

1. **Zero border radius.** `--radius` is `0px` and the whole radius scale
   derives from it. Corners are cut with `clip-path: var(--notch4)`, never
   rounded. `rounded-full` survives only on avatars and status dots.
2. **One pixel unit.** `--c` is `8px` (4px below 600px). Any new spacing for
   brand surfaces (frames, seams, art, strips) is a multiple of `--c`.
   Tailwind's spacing scale is fine for ordinary layout and text.
3. **Flat colour only.** No `linear-gradient`, no blurred shadow, no glass, no
   glow. Depth is flat tone stacking, a 2-tone checkerboard dither, a 1px rule,
   or a `drop-shadow`/`box-shadow` with **0 blur** offset by one cell.
4. **Two type voices.** Geist for UI and headings (600, tight tracking), Geist
   Mono for machine strings (ids, hosts, counts, timestamps, code). Jersey 10
   only for large pixel numerals and the severity chip. Never Jersey for prose
   or for anything under ~20px.
5. **Chrome is light-on-oxblood, content is ink-on-paper.** The sidebar, page
   header and marketing-like bands use `--field`/`--cream`/`--amber`. Cards,
   tables, forms and chat use the light theme (paper/ink) and switch to dusk
   under `.dark`.
6. **Colour means status, never decoration.** `--ok`/`--ok-t` and
   `--bad`/`--bad-t` are the only status pairs. A status is expressed once on
   the wrapper (`.tone-ok`, `.tone-bad`, `.tone-unknown`), not per child.
7. **The landing's palette is closed.** Do not introduce teal, blue, purple or
   extra greys. `--dusk` and `--dusk-2` exist for charts and secondary accents
   only.
8. **Borders are 2px, rules are 1px.** Frames around interactive surfaces are
   `2px` (or a 4px stacked frame). Separators are `1px var(--line)` /
   `var(--line-soft)`.
9. **Motion is stepped and optional.** `step-end`/`steps()` only, no easing, no
   `transition: all`. Everything animation-related lives inside
   `@media (prefers-reduced-motion: no-preference)`.
10. **Accessibility is not negotiable.** The contrast table in §5 is the
    allowed set. Focus is a visible 3px ring. Decorative art is
    `aria-hidden="true"`.

## 4. Palette

Sampled from `landing/styles.css`. Names are the landing names; the semantic
shadcn mapping lives in §6.

### Surfaces and ink

| Token | Hex | Role |
|---|---|---|
| `--field` | `#200412` | Brand field: sidebar, header chrome, hero bands |
| `--night` | `#160610` | Dark page ground (`.dark` background) |
| `--night-2` | `#12060B` | Inset panels, code blocks, table heads |
| `--plum` | `#2A0A18` | Quiet panels, inline code, dark muted |
| `--plum-2` | `#3A1020` | Raised dark panel, dark accent |
| `--dusk` | `#22102E` | Secondary accent (charts only) |
| `--dusk-2` | `#2E1A44` | Secondary accent hover (charts only) |
| `--cream` | `#FBF2E8` | Primary text on dark, paper surface |
| `--cream-2` | `#E9D8CE` | Secondary text on dark |
| `--muted-ink` | `#BFA69E` | Muted text on dark |
| `--dim` | `#A98D93` | Fine print, captions on dark |
| `--line` | `#40202A` | 1px rules and dark borders |
| `--line-soft` | `#2C1119` | Quiet separators on dark |
| `--ink` | `#0E0409` | Shadow colour and outer frame on art |

### Paper (light content surfaces)

| Token | Hex | Role |
|---|---|---|
| `--paper` | `#FBF2E8` | Page and card background in light theme |
| `--paper-ink` | `#1A1215` | Body text on paper |
| `--paper-muted` | `#5C5255` | Secondary text on paper |
| `--paper-line` | `#D9CBC3` | Borders and rules on paper |
| `--paper-accent` | `#EFE3DA` | Selected row, accent chip, secondary button |

### Accent and status

| Token | Hex | Role |
|---|---|---|
| `--amber` | `#FF6F30` | Primary action, active nav, live marker |
| `--amber-hi` | `#FFA66E` | Hover text on dark, accent foreground |
| `--amber-deep` | `#B4431A` | Accent on paper, light-theme focus ring |
| `--ok` / `--ok-t` | `#0B6B3A` / `#DDEFE3` | Success tone (fg / bg) |
| `--bad` / `--bad-t` | `#9E141B` / `#FBE1DE` | Error / destructive tone (fg / bg) |

Do not use `--amber` as text on paper (contrast 1.8:1). On paper use
`--amber-deep` for accent text and `--paper-ink` for body text.

## 5. Verified contrast (WCAG 2.1)

Computed from the hexes above. A new pair must be added here with its ratio
before it ships.

| Pair | Ratio | Verdict |
|---|---|---|
| `--cream` on `--field` | 17.4 | AAA |
| `--amber` on `--field` | 7.0 | AAA |
| `--amber-hi` on `--field` | 10.1 | AAA |
| `--cream-2` on `--night` | 14.2 | AAA |
| `--muted-ink` on `--night` | 8.6 | AAA |
| `--dim` on `--night` | 6.5 | AA |
| `--paper-ink` on `--paper` | 16.6 | AAA |
| `--paper-muted` on `--paper` | 6.8 | AA |
| `--amber-deep` on `--paper` | 5.0 | AA |
| `--paper-ink` on `--paper-accent` | 14.6 | AAA |
| `--field` on `--amber` (primary button) | 7.0 | AAA |
| `--cream` on `--bad` | 7.4 | AAA |
| `--cream` on `--ok` | 6.0 | AA |
| `--ok` on `--ok-t` | 5.5 | AA |
| `--bad` on `--bad-t` | 6.6 | AA |
| `--cream` on `--plum` | 16.4 | AAA |

Known trap: `--amber-deep` on `--paper-accent` is **4.4:1** (below AA for body
text). Use `--paper-ink` on accent surfaces.

## 6. Semantic mapping (shadcn-svelte / Tailwind)

The dashboard is built from shadcn-svelte components, so the brand is expressed
through their semantic variables rather than by restyling each component.
`layout.css` owns the mapping:

| Semantic var | Light (paper) | Dark (dusk) |
|---|---|---|
| `--background` | `--paper` | `--night` |
| `--foreground` | `--paper-ink` | `--cream` |
| `--card` / `--popover` | `--paper` | `--field` |
| `--primary` | `--amber` | `--amber` |
| `--primary-foreground` | `--field` | `--field` |
| `--secondary` / `--accent` | `--paper-accent` | `--plum` / `--plum-2` |
| `--muted-foreground` | `--paper-muted` | `--muted-ink` |
| `--border` / `--input` | `--paper-line` | `--line` |
| `--ring` | `--amber-deep` | `--amber` |
| `--destructive` | `--bad` | `--bad` |
| `--sidebar` | `--field` | `--field` |
| `--sidebar-foreground` | `--cream-2` | `--cream-2` |
| `--sidebar-accent` | `--plum` | `--plum-2` |
| `--radius` | `0px` | `0px` |

Usage rules:

- Use semantic utilities (`bg-background`, `bg-card`, `text-muted-foreground`,
  `border-border`, `bg-primary`, `text-primary-foreground`). They are the only
  theme-aware path.
- Use brand utilities (`bg-field`, `text-cream`, `text-amber`, `border-line`,
  `bg-plum`, `font-pixel`, ...) only for fixed chrome that must not flip with
  the theme: sidebar rows, hero bands, pixel numerals, the wordmark strip.
- Sidebar is always `--field`, in both themes. Do not "fix" it to match the
  page in light mode; the contrast between dark chrome and paper content is the
  brand.
- Component classes provided by `layout.css`: `.notch`, `.frame-ink`,
  `.frame-amber`, `.brand-shadow`, `.dither`, `.tone-ok`, `.tone-bad`,
  `.tone-unknown`.

## 7. Typography

Loaded from Google Fonts in `frontend/src/app.html` (the same request the
landing uses): Geist 100–900, Geist Mono 100–900, Jersey 10 400, with
`display=swap`.

| Role | Family | Size / weight | Where |
|---|---|---|---|
| Page title (`h1`) | Geist | `clamp(32px, 4vw, 42px)` / 600, `letter-spacing: -0.04em` | `.font-display`, `text-4xl` |
| Section title (`h2`, `Card.Title`) | Geist | 22–28px / 600, `-0.03em` | cards, sections |
| Body | Geist | 16px / 1.65 | prose, forms |
| Meta / label | Geist Mono | 11–13px, uppercase, `letter-spacing: 0.08–0.16em` | table heads, stats labels, badges |
| Machine strings | Geist Mono | 13–15px, `tabular-nums` | ids, sizes, timestamps, code |
| Pixel numeral | Jersey 10 | 40–56px / 1 | stat counters, severity plate |

Rules:

- Display type is always weight 400 for Jersey 10 and 600 for Geist. Never
  synthesise bold on Jersey.
- Never apply `font-pixel` to a paragraph or to a control label.
- Numeric columns and counters use `font-variant-numeric: tabular-nums`.
- Keep prose measures at 65–72ch.

## 8. Surfaces and framing

### 8.1 The notch

```css
.notch { clip-path: var(--notch4); }
```

The polygon removes a 4x4 square from each corner. `clip-path` clips borders
too, so a framed surface is built by stacking filled layers, not by `border`:

```svelte
<div class="frame-ink"><div class="frame-amber"><div class="notch bg-paper p-4">…</div></div></div>
```

Use this for: hero art, feature panels, receipt/evidence cards, empty states
that must read as printed notices. Do **not** wrap every card; ordinary data
cards use `bg-card` + `border` so tables and forms stay dense.

### 8.2 Offset shadow

```css
.brand-shadow { filter: drop-shadow(8px 8px 0 #060205); }
```

`filter` (not `box-shadow`) so the shadow follows the notched silhouette.
Offset is one `--c` cell, down-right, zero blur. Use on at most one element per
viewport region; it is a printed-poster depth cue, not a card default.

### 8.3 Dither

Band boundaries are a 2x2 checkerboard of two flat tones, never a gradient:

```css
background-size: 8px 8px;
background-image: repeating-conic-gradient(var(--field) 0 25%, var(--night-2) 0 50%);
```

`.dither` is the default seam. Place it at a boundary with a 4px overlap
(`top: calc(boundary - 4px)`), as the landing does.

### 8.4 Pixel art

The keep (`2ff-back.png`) is the only illustration. Render it with
`image-rendering: pixelated`, inside the amber frame, at 2x for retina:

```svelte
<img src="/brand/2ff-back.png" srcset="/brand/2ff-back.png 1x, /brand/2ff-back@2x.png 2x"
     alt="Pixel-art castle at dusk: two cream towers with amber beacons on a dark hill."
     width="424" height="338" class="w-full [image-rendering:pixelated]" />
```

Do not recolour, resample or animate it. Do not add other raster illustration:
it clashes with the pixel grid.

## 9. Component recipes

### 9.1 Wordmark

`src/lib/components/brand.svelte` uses the copied PNG, never a text lockup:

```svelte
<img src="/brand/affido-wordmark.png" alt="Affido" width="512" height="208" class="h-8 w-auto" />
```

Collapsed sidebar uses the FF monogram (`/brand/favicon.svg`) at `size-8`.
Alt text is `Affido`; the wordmark is not decorative.

### 9.2 Page header

- Eyebrow: `font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground`
  with an 8px amber blip (`size-2 bg-amber`) before it.
- Title: `.font-display`.
- Lead: `text-sm text-muted-foreground`, max `max-w-xl`.
- One primary action on the right. Primary = amber fill, field text.

### 9.3 Stats

Counters are the one place the pixel face belongs on the dashboard:

```svelte
<span class="font-pixel text-5xl text-primary tabular-nums">{value}</span>
<span class="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">{label}</span>
```

Stat grids use 1px `--line-soft` separators and no card shadow. Four cells on
desktop, two on mobile.

### 9.4 Buttons

Use the shadcn button. Brand mapping is done by tokens, not by overrides:

| Variant | Light | Dark |
|---|---|---|
| `default` | amber bg, field text | same |
| `secondary` | paper-accent bg, ink text | plum bg, cream text |
| `outline` | 1px paper-line, ink text | 1px line, cream text |
| `ghost` | transparent, hover paper-accent | transparent, hover plum |
| `destructive` | bad bg, bad-t text | same |

Buttons are `rounded-none` because the radius scale is 0. Do not add
`shadow-sm`, gradients or icon-only circles. Icon buttons stay notched squares.

### 9.5 Status and badges

Status is a tone pair on the wrapper:

```svelte
<div class="tone-bad notch px-3 py-2 font-mono text-xs uppercase">rejected</div>
<div class="tone-ok notch px-3 py-2 font-mono text-xs uppercase">verified</div>
```

The pair sets both colours; children inherit. Do not write
`bg-green-100 text-green-700` or any Tailwind default palette colour. Badges
use `outline`/`secondary` variants by default; `default` (amber) marks the one
active or primary item in a group.

### 9.6 Tables

- Table head: `font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground`.
- Row separators: 1px `border-border`.
- Numeric cells: right aligned, mono, `tabular-nums`.
- Hover: flat `bg-muted/50`; never a shadow or a transform.
- The table's first rule (above the head) may be 2px; internal rules stay 1px.

### 9.7 Forms and chat composer

- Input height 40–52px, `rounded-none`, `border` 2px on brand surfaces (1px is
  acceptable inside dense settings forms), `bg-card`, `text-foreground`.
- Focus: the global 3px `--ring` ring. On paper the ring is `--amber-deep`; do
  not replace it with a browser default.
- Placeholder: `text-muted-foreground`.
- Chat assistant text is prose (Geist); tool names, ids and token counts are
  mono. Citations render as amber superscripts, never as blue links.
- Streaming indicator: 8px amber block blinking with `step-end` (see §11).

### 9.8 Empty states

Empty states are printed notices: `.notch`, `bg-card`, 1px border, a pixel
glyph or lucide icon, one sentence, one action. No illustration, no large
centred gradient.

## 10. Assets

Copied verbatim from `pi-durable-containers/landing/` into `frontend/static/`.
Do not edit them; if the brand board changes, replace from the landing in the
same change and update the table.

| Path | Source | Size | Use |
|---|---|---|---|
| `static/brand/affido-wordmark.png` | `affido-wordmark.png` | 512x208 | Sidebar/header wordmark |
| `static/brand/2ff-back.png` | `2ff-back.png` | 424x338 | Hero/empty-state keep (1x) |
| `static/brand/2ff-back@2x.png` | `2ff-back@2x.png` | 848x676 | Retina keep (2x) |
| `static/brand/2ff-header.png` | `2ff-header.png` | 921x289 | Original wordmark sheet (archive) |
| `static/brand/brand-board.png` | `Brand Fortress aFFido.png` | 1536x1024 | Brand reference board (archive) |
| `static/brand/favicon.svg` | `favicon.svg` | 32x32 | FF monogram |
| `static/favicon.svg` | `favicon.svg` | 32x32 | Served favicon |
| `static/apple-touch-icon.png` | `apple-touch-icon.png` | 180x180 | iOS home screen |
| `static/og.png` | `og.png` | 1200x630 | Social card |
| `src/lib/assets/favicon.svg` | `favicon.svg` | 32x32 | Imported by `+layout.svelte` |

`app.html` sets `theme-color` to `#200412` and links the apple-touch icon, so
mobile browser chrome matches the brand field.

## 11. Motion

All animation is gated by `prefers-reduced-motion: no-preference`. Keyframes
are `step-end`, durations 0.5–1.9s, phases seeded with negative delays.

Allowed dashboard motion:

| Effect | Spec |
|---|---|
| Live/streaming marker | 8px amber block, `blink 1.6s step-end infinite` |
| Selected nav caret | 4px horizontal nudge, `1s step-end infinite` |
| Panel entrance | `pop 150ms steps(3, end)`, scale .97 → 1 |
| Skeleton | flat `--plum` blocks, stepped opacity, no shimmer gradient |

Forbidden: `ease`, `transition: all`, blurred glows, parallax, spring easing,
animated gradients, spinner rings. A loading state is a stepped pixel pattern
or a static label, not a smooth spinner.

## 12. Accessibility

- The §5 table is the allowed contrast set. Add a row before introducing a
  pair.
- `:focus-visible` is `3px solid var(--ring)` with `3px` offset, globally.
  Inside a clipped frame, use `outline-offset: -7px` so the ring is not cut.
- Every icon-only button needs `aria-label`. Every decorative SVG/image gets
  `aria-hidden="true"`/empty alt. The keep is content: it keeps its alt text.
- Live regions for chat streaming and task status: `role="status"`,
  `aria-live="polite"`, `aria-atomic="true"`.
- Touch targets: 44px minimum for primary controls; 32px acceptable for chips
  and secondary icon buttons.
- Do not encode status by colour alone: pair the tone with a word
  (`verified`, `rejected`, `paused`).

## 13. Enforcement

A pull request that touches `frontend/` passes the visual gate when all of
these hold (run from `frontend/`):

```bash
# 1. no raw hex outside layout.css, the theme-color meta and SVG artwork
rg -n '#[0-9a-fA-F]{6}\b' src --glob '!src/routes/layout.css' --glob '!src/app.html' \
  --glob '!*.svg' --glob '!src/routes/demo/**'

# 2. no theme colours from Tailwind's default palette
rg -n '(bg|text|border|ring|from|to)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}' src \
  --glob '!src/lib/components/ui/**' --glob '!src/routes/demo/**'

# 3. the radius scale stays zero; no product file sets an explicit radius
rg -n -- '--radius:\s*[1-9]' src/routes/layout.css
rg -n 'rounded-\[[0-9]' src --glob '!src/lib/components/ui/**' --glob '!src/routes/demo/**'

# 4. typecheck and lint
pnpm check && pnpm lint
```

`src/app.html` may carry exactly one literal, `<meta name="theme-color"
content="#200412">`, because the browser chrome colour cannot reference a CSS
variable.

Expected result: commands 1–3 print nothing. `src/routes/demo/**` is
better-auth's example scaffolding, not a product surface; it is excluded from
the palette gate and is a follow-up to replace or delete. Vendored
`src/lib/components/ui/**` is excluded from the palette gate because it ships
with shadcn-svelte.

Review rules:

- A new colour, font size step or radius is a change to this document, not a
  local styling choice.
- A screen that needs a "special" panel reuses `.notch` / `.frame-*` /
  `.brand-shadow`; it does not invent a new border treatment.
- Sidebar and chrome stay `--field` in both themes.
- When `layout.css` and this document disagree, `layout.css` is what ships:
  fix the document in the same commit.

Known migrated product surfaces: `layout.css` tokens and base rules,
`app.html` font and meta tags, `brand.svelte`, the `/`, `/login`,
`/login/forgot`, `/login/reset` headers, the dashboard sidebar badge,
`dashboard/skills` verification tones, and the `trace-graph` JSON panel. The
rest of the dashboard already resolves through the semantic tokens; remaining
`rounded-*` classes are inert because the radius scale is 0.

## 14. Exceptions

| Case | Allowed deviation |
|---|---|
| Avatars | `rounded-full` (a circle is a person, not a panel) |
| Status dots / legend markers | `rounded-full` at 6–8px |
| Switch track and thumb, scrollbar thumb, progress track | `rounded-full`; these are native control affordances and are part of `lib/components/ui` |
| `src/routes/demo/**` | better-auth example pages; not product surfaces, pending removal |
| `trace-graph.svelte` canvas | May use `--dusk`/`--dusk-2` lanes and `--ok`/`--bad` edges; still no gradients or blur |
| Print/export HTML in `agent/` | Out of scope; not part of the dashboard |

Any other exception needs a line in this table before merge.

## 15. Out of scope

- Copy and information architecture. This RFC changes appearance, not wording;
  product names in page titles ("Durable") are a separate rename.
- The agent-generated documents (`.docx` output) and the `docs/rfc/*.html`
  explainers.
- A user-facing theme toggle. The `.dark` class exists and is mapped; wiring a
  switcher is a follow-up.
- Self-hosting the fonts. Google Fonts is the current path, matching the
  landing; if the app moves behind a CSP that blocks `fonts.gstatic.com`, add
  `@fontsource` packages and replace the `<link>` in `app.html`.
- Dependency cleanup. `@fontsource-variable/inter` and
  `@fontsource/instrument-serif` are no longer imported; remove them with the
  next intentional dependency change (not as a drive-by lockfile edit).

## 16. Provenance and licensing

The techniques (4px notched clip-path, dithered seams, pixel-unit grid,
tone-pair status) are generic and documented in
`landing/web_design_style.md` §14. The palette, wordmark, keep, FF monogram and
brand board are Affido assets, copied here from the landing. No
ProjectDiscovery artwork, copy or wordmark path data is included.
