# Brand Color Palettes — Pre-Built Presets

When the user says "style X" or describes a visual identity, match against these presets.
Each preset provides the 8 style tokens ready to paste into generator-template.js.

## How to Add a New Palette

Copy an existing block and change the colors. The token names must match exactly:
`PRIMARY`, `SECONDARY`, `DARK`, `LIGHT_BG`, `ACCENT`, `TH_BG`, `TR_ALT`, `BORDER`, `GRAY`.

---

## palette: arbdeco

**Look & feel:** Premium consulting, purple-blue. Authoritative but warm.
**Best for:** Proposals, strategy documents, consulting deliverables.

```javascript
const PRIMARY    = "6B2FA0";  // Deep purple
const SECONDARY  = "2D6CC0";  // Blue
const DARK       = "1A1A2E";  // Dark navy
const LIGHT_BG   = "F5F0FA";  // Very light purple
const ACCENT     = "8B5CF6";  // Medium purple
const TH_BG      = "E8D5F5";  // Light purple for table headers
const TR_ALT     = "F9F5FF";  // Ultra-light purple for table rows
const BORDER     = "C4A8E8";  // Soft purple border
const GRAY       = "555555";  // Body text
```

---

## palette: corporate-blue

**Look & feel:** Traditional corporate, trustworthy, conservative.
**Best for:** Financial reports, board presentations, legal documents.

```javascript
const PRIMARY    = "1B3A5C";  // Dark navy blue
const SECONDARY  = "2E75B6";  // Medium blue
const DARK       = "0D1B2A";  // Near-black navy
const LIGHT_BG   = "EEF2F7";  // Ice blue
const ACCENT     = "5B9BD5";  // Light blue
const TH_BG      = "D6E4F0";  // Light blue for table headers
const TR_ALT     = "F2F6FA";  // Ultra-light blue for rows
const BORDER     = "B4C6DC";  // Steel blue border
const GRAY       = "4A4A4A";  // Body text
```

---

## palette: modern-slate

**Look & feel:** Tech-forward, minimalist, high contrast.
**Best for:** SaaS proposals, tech documentation, startup pitch decks.

```javascript
const PRIMARY    = "1E1E1E";  // Near black
const SECONDARY  = "4A4A4A";  // Dark gray
const DARK       = "121212";  // Black
const LIGHT_BG   = "F7F7F7";  // Off-white
const ACCENT     = "0066CC";  // Electric blue accent
const TH_BG      = "E8E8E8";  // Light gray for table headers
const TR_ALT     = "FAFAFA";  // Near-white for rows
const BORDER     = "CCCCCC";  // Medium gray border
const GRAY       = "555555";  // Body text
```

---

## palette: warm-elegance

**Look & feel:** Italian elegance, warm and refined.
**Best for:** Design proposals, catering/hospitality, luxury brand documents.

```javascript
const PRIMARY    = "8B4513";  // Saddle brown
const SECONDARY  = "A0522D";  // Sienna
const DARK       = "2C1810";  // Dark espresso
const LIGHT_BG   = "FDF5EF";  // Warm cream
const ACCENT     = "D4A76A";  // Gold accent
const TH_BG      = "F5E6D3";  // Light tan for table headers
const TR_ALT     = "FDF9F5";  // Very light cream for rows
const BORDER     = "D2B48C";  // Tan border
const GRAY       = "5C4033";  // Warm gray body text
```

---

## palette: green-sustainable

**Look & feel:** Environmental, fresh, organic.
**Best for:** Sustainability reports, green tech, agriculture/energy proposals.

```javascript
const PRIMARY    = "2E7D32";  // Forest green
const SECONDARY  = "388E3C";  // Medium green
const DARK       = "1B3A1B";  // Dark green
const LIGHT_BG   = "E8F5E9";  // Very light green
const ACCENT     = "66BB6A";  // Light green
const TH_BG      = "C8E6C9";  // Light green for table headers
const TR_ALT     = "F1F8E9";  // Ultra-light green for rows
const BORDER     = "A5D6A7";  // Soft green border
const GRAY       = "4A5D4A";  // Green-gray body text
```

---

## palette: medical-clean

**Look & feel:** Sterile, trustworthy, clinical.
**Best for:** Medical reports, pharmaceutical documents, healthcare proposals.

```javascript
const PRIMARY    = "0077B6";  // Medical blue
const SECONDARY  = "00B4D8";  // Cyan
const DARK       = "03045E";  // Deep blue
const LIGHT_BG   = "E8F4FD";  // Very light blue
const ACCENT     = "48CAE4";  // Bright cyan
const TH_BG      = "DBF0FA";  // Light blue for table headers
const TR_ALT     = "F5FAFD";  // Ultra-light blue for rows
const BORDER     = "B8D8EB";  // Soft blue border
const GRAY       = "4A5568";  // Body text
```

---

## palette: legal-authority

**Look & feel:** Serious, authoritative, traditional.
**Best for:** Legal briefs, compliance documents, government submissions.

```javascript
const PRIMARY    = "4A0E0E";  // Dark burgundy
const SECONDARY  = "6B2020";  // Deep red
const DARK       = "1A0A0A";  // Very dark
const LIGHT_BG   = "FDF5F5";  // Very light red
const ACCENT     = "8B3A3A";  // Muted red
const TH_BG      = "F0D9D9";  // Light red for table headers
const TR_ALT     = "FDF8F8";  // Ultra-light red for rows
const BORDER     = "CDA5A5";  // Soft red border
const GRAY       = "4A3A3A";  // Warm dark gray body text
```

---

## palette: construction-industrial

**Look & feel:** Solid, technical, no-nonsense. Industrial and construction.
**Best for:** Construction proposals, engineering docs, technical manuals.

```javascript
const PRIMARY    = "F47920";  // Safety orange
const SECONDARY  = "3D3D3D";  // Dark gray
const DARK       = "1A1A1A";  // Near black
const LIGHT_BG   = "FFF5EE";  // Very light orange
const ACCENT     = "FF8C42";  // Bright orange
const TH_BG      = "FFE4CC";  // Light orange for table headers
const TR_ALT     = "FFF9F5";  // Ultra-light warm for rows
const BORDER     = "E0C8B0";  // Warm gray border
const GRAY       = "4A4A4A";  // Body text
```

---

## Matching Heuristics

When the user describes a style verbally, match loosely:

| User says | Match palette | Adapt as |
|-----------|--------------|----------|
| "elegante", "lusso", "raffinato" | warm-elegance | Use as-is |
| "tecnico", "tecnologico", "SaaS" | modern-slate | Use as-is |
| "aziendale", "corporate", "banca" | corporate-blue | Use as-is |
| "consulenza", "strategia", "proposta" | arbdeco | Use as-is |
| "legale", "contratto", "compliance" | legal-authority | Use as-is |
| "medico", "sanitario", "farmaceutico" | medical-clean | Use as-is |
| "edilizia", "costruzioni", "industriale" | construction-industrial | Use as-is |
| "ambiente", "green", "sostenibilità" | green-sustainable | Use as-is |
| "serio", "formale", "istituzionale" | corporate-blue | Darken colors 10% |
| "moderno", "minimal", "pulito" | modern-slate | Use as-is |
| "caldo", "accogliente", "artigianale" | warm-elegance | Lighten 5% |

If the user's description doesn't clearly match, use `corporate-blue` as the safe default
after asking: "Uso uno stile corporate blu classico, va bene? O preferisci un altro stile?"
