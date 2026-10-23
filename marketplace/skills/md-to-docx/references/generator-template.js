// =============================================================================
// generator-template.js — Reusable DOCX generation template (sandbox edition)
// =============================================================================
// Copy this file to the workspace root as generate_<name>.js and fill in:
//   1. STYLE TOKENS (8 colors + font choices)
//   2. LOGO_PATH (or set to null)
//   3. OUTPUT_FILENAME (the document always lands under artifacts/)
//   4. DOCUMENT CONTENT (children array)
//
// `require('docx')` resolves through NODE_PATH: the library is baked into the
// sandbox image. Never install anything — nothing can be.
// =============================================================================

const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, Header, Footer, AlignmentType, HeadingLevel, BorderStyle,
  WidthType, ShadingType, PageNumber, PageBreak, LevelFormat,
  TabStopType, TabStopPosition
} = require('docx');
const fs = require('fs');
const path = require('path');

// =============================================================================
// CONFIGURATION — Fill these in
// =============================================================================

// Paths. The logo may live under uploads/; the output always lands under
// artifacts/ — the only directory the user can download from.
const LOGO_PATH = path.join(process.cwd(), 'logo.png');
const OUTPUT_DIR = path.join(process.cwd(), 'artifacts');
const OUTPUT_FILENAME = 'Document.docx';

// Font configuration
const HEADING_FONT = "Arial";
const BODY_FONT = "Arial";

// =============================================================================
// STYLE TOKENS — Replace with extracted/defined brand colors
// =============================================================================

const PRIMARY    = "6B2FA0";  // Main brand color (headings, dividers)
const SECONDARY  = "2D6CC0";  // Secondary color (subheadings, accents)
const DARK       = "1A1A2E";  // Near-black (bold body text)
const LIGHT_BG   = "F5F0FA";  // Very light tint (callout background)
const ACCENT     = "8B5CF6";  // Accent (borders, table underlines)
const TH_BG      = "E8D5F5";  // Table header background
const TR_ALT     = "F9F5FF";  // Table row alternating background
const BORDER     = "C4A8E8";  // Table border color
const WHITE      = "FFFFFF";
const GRAY       = "555555";  // Body text color

// =============================================================================
// LOGO
// =============================================================================

let logoData = null;
try { logoData = fs.readFileSync(LOGO_PATH); } catch(e) { /* no logo */ }

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

// --- Headings ---

const makeHeading1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  spacing: { before: 360, after: 200 },
  children: [new TextRun({ text, bold: true, size: 36, color: PRIMARY, font: HEADING_FONT })]
});

const makeHeading2 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  spacing: { before: 280, after: 140 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: ACCENT, space: 4 } },
  children: [new TextRun({ text, bold: true, size: 28, color: SECONDARY, font: HEADING_FONT })]
});

const makeHeading3 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  spacing: { before: 220, after: 100 },
  children: [new TextRun({ text, bold: true, size: 24, color: DARK, font: HEADING_FONT })]
});

// --- Body text ---

const makeBody = (text, options = {}) => new Paragraph({
  spacing: { before: 80, after: 80 },
  children: [new TextRun({ text, size: 22, color: GRAY, font: BODY_FONT, ...options.runOptions })]
});

const makeBold = (text) => new Paragraph({
  spacing: { before: 80, after: 80 },
  children: [new TextRun({ text, bold: true, size: 22, color: DARK, font: BODY_FONT })]
});

const makeItalic = (text) => new Paragraph({
  spacing: { before: 80, after: 80 },
  children: [new TextRun({ text, italics: true, size: 22, color: GRAY, font: BODY_FONT })]
});

// --- Lists (use numbering system, NEVER unicode characters) ---

const makeBullet = (text, level = 0) => new Paragraph({
  numbering: { reference: "bullets", level },
  spacing: { before: 60, after: 60 },
  children: [new TextRun({ text, size: 22, color: GRAY, font: BODY_FONT })]
});

const makeNumbered = (text, level = 0) => new Paragraph({
  numbering: { reference: "numbers", level },
  spacing: { before: 60, after: 60 },
  children: [new TextRun({ text, size: 22, color: GRAY, font: BODY_FONT })]
});

// --- Special elements ---

const spacer = (size = 200) => new Paragraph({
  spacing: { before: size, after: 0 },
  children: [new TextRun("")]
});

const makeDivider = () => new Paragraph({
  spacing: { before: 160, after: 160 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: PRIMARY, space: 1 } },
  children: [new TextRun("")]
});

/**
 * Callout box — left accented border, light background.
 * Use for: important notes, key takeaways, blockquotes.
 */
const makeCallout = (text) => new Table({
  width: { size: 9026, type: WidthType.DXA },
  columnWidths: [9026],
  rows: [new TableRow({
    children: [new TableCell({
      borders: {
        top:    { style: BorderStyle.SINGLE, size: 8, color: PRIMARY },
        bottom: { style: BorderStyle.SINGLE, size: 8, color: PRIMARY },
        left:   { style: BorderStyle.SINGLE, size: 24, color: PRIMARY },
        right:  { style: BorderStyle.NONE, size: 0, color: PRIMARY }
      },
      width: { size: 9026, type: WidthType.DXA },
      shading: { fill: LIGHT_BG, type: ShadingType.CLEAR },
      margins: { top: 120, bottom: 120, left: 240, right: 240 },
      children: [new Paragraph({
        children: [new TextRun({ text, size: 22, color: DARK, font: BODY_FONT, italics: true })]
      })]
    })]
  })]
});

// --- Tables ---

const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: BORDER };
const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };
const noB = { style: BorderStyle.NONE, size: 0, color: WHITE };
const noBorders = { top: noB, bottom: noB, left: noB, right: noB };

const makeTableHeaderCell = (text, width) => new TableCell({
  borders: cellBorders,
  width: { size: width, type: WidthType.DXA },
  shading: { fill: TH_BG, type: ShadingType.CLEAR },
  margins: { top: 100, bottom: 100, left: 140, right: 140 },
  children: [new Paragraph({
    children: [new TextRun({ text, bold: true, size: 20, color: PRIMARY, font: BODY_FONT })]
  })]
});

const makeTableCell = (text, width, alt = false, bold = false) => new TableCell({
  borders: cellBorders,
  width: { size: width, type: WidthType.DXA },
  shading: { fill: alt ? TR_ALT : WHITE, type: ShadingType.CLEAR },
  margins: { top: 80, bottom: 80, left: 140, right: 140 },
  children: [new Paragraph({
    children: [new TextRun({ text, size: 20, color: bold ? DARK : GRAY, bold, font: BODY_FONT })]
  })]
});

// =============================================================================
// DOCUMENT DEFINITION
// =============================================================================

// Width constants for A4 with 1134 DXA margins (1134 ≈ 2 cm)
const CONTENT_WIDTH = 9638; // 11906 - 2*1134

const doc = new Document({
  numbering: {
    config: [
      {
        reference: "bullets",
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: "\u2022", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: LevelFormat.BULLET, text: "\u25E6", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 1080, hanging: 360 } } } },
        ]
      },
      {
        reference: "numbers",
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
        ]
      },
    ]
  },
  styles: {
    default: { document: { run: { font: BODY_FONT, size: 22 } } },
    paragraphStyles: [
      {
        id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: HEADING_FONT, color: PRIMARY },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 }
      },
      {
        id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: HEADING_FONT, color: SECONDARY },
        paragraph: { spacing: { before: 280, after: 140 }, outlineLevel: 1 }
      },
      {
        id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 24, bold: true, font: HEADING_FONT, color: DARK },
        paragraph: { spacing: { before: 220, after: 100 }, outlineLevel: 2 }
      },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 11906, height: 16838 },  // A4
        margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 }
      }
    },
    headers: {
      default: new Header({
        children: [
          new Paragraph({
            spacing: { before: 0, after: 0 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: PRIMARY, space: 4 } },
            children: [
              // Logo in header (if available)
              ...(logoData ? [
                new ImageRun({
                  type: "png", data: logoData,
                  transformation: { width: 60, height: 57 },
                  altText: { title: "Logo", description: "Company Logo", name: "Logo" }
                }),
                new TextRun({ text: "\t", font: BODY_FONT }),
              ] : []),
              new TextRun({ text: "Document Title — Confidential", size: 18, color: GRAY, font: BODY_FONT }),
            ],
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }]
          })
        ]
      })
    },
    footers: {
      default: new Footer({
        children: [
          new Paragraph({
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: ACCENT, space: 4 } },
            spacing: { before: 80, after: 0 },
            children: [
              new TextRun({ text: "Confidential Document", size: 16, color: GRAY, font: BODY_FONT }),
              new TextRun({ text: "\t", font: BODY_FONT }),
              new TextRun({ text: "Page ", size: 16, color: GRAY, font: BODY_FONT }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: GRAY, font: BODY_FONT }),
            ],
            tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }]
          })
        ]
      })
    },
    children: [
      // =======================================================================
      // COVER PAGE
      // =======================================================================
      spacer(600),

      // Logo (centered, large)
      ...(logoData ? [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 0, after: 400 },
          children: [new ImageRun({
            type: "png", data: logoData,
            transformation: { width: 160, height: 151 },
            altText: { title: "Logo", description: "Company Logo", name: "LogoCover" }
          })]
        })
      ] : []),

      // Company name
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 100 },
        children: [new TextRun({ text: "COMPANY NAME", bold: true, size: 28, color: PRIMARY, font: HEADING_FONT })]
      }),

      spacer(300),

      // Document type
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 120 },
        children: [new TextRun({ text: "DOCUMENT TYPE", bold: true, size: 52, color: DARK, font: HEADING_FONT })]
      }),

      // Subtitle
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 60 },
        children: [new TextRun({ text: "Subtitle or description here", size: 26, color: SECONDARY, font: BODY_FONT, italics: true })]
      }),

      spacer(400),

      // Metadata table (no borders, centered)
      new Table({
        width: { size: 5000, type: WidthType.DXA },
        columnWidths: [2200, 2800],
        alignment: AlignmentType.CENTER,
        rows: [
          makeCoverRow("Recipient:", "Client Name"),
          makeCoverRow("Date:", new Date().toLocaleDateString('it-IT', { year: 'numeric', month: 'long', day: 'numeric' })),
          makeCoverRow("Prepared by:", "Author Name"),
          makeCoverRow("Reference:", "REF-001"),
        ]
      }),

      spacer(200),
      new Paragraph({ children: [new PageBreak()] }),

      // =======================================================================
      // DOCUMENT BODY — Replace with actual content from markdown
      // =======================================================================
      makeHeading1("1. Section Title"),
      makeBody("Body paragraph text goes here. This is where the markdown content is mapped to docx elements."),
      spacer(80),
      makeHeading2("1.1 Subsection"),
      makeBody("More content..."),
      makeBullet("First bullet point"),
      makeBullet("Second bullet point"),
      makeDivider(),
      makeHeading1("2. Another Section"),
      makeBody("Content continues..."),
      makeCallout("This is a callout box for important information, key takeaways, or blockquotes from the markdown."),

      // =======================================================================
      // CLOSING
      // =======================================================================
      spacer(400),
      makeDivider(),
      spacer(200),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 200, after: 100 },
        children: [new TextRun({ text: "Company Name", bold: true, size: 28, color: PRIMARY, font: HEADING_FONT })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 80 },
        children: [new TextRun({ text: "Author — Role", size: 22, color: GRAY, font: BODY_FONT })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 80 },
        children: [new TextRun({ text: "Confidential document", size: 20, color: GRAY, font: BODY_FONT, italics: true })]
      }),
    ]
  }]
});

// =============================================================================
// HELPER: Cover page metadata row
// =============================================================================

function makeCoverRow(label, value) {
  return new TableRow({
    children: [
      new TableCell({
        borders: noBorders,
        width: { size: 2200, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true, size: 20, color: GRAY, font: BODY_FONT })] })]
      }),
      new TableCell({
        borders: noBorders,
        width: { size: 2800, type: WidthType.DXA },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ children: [new TextRun({ text: value, bold: true, size: 20, color: DARK, font: BODY_FONT })] })]
      })
    ]
  });
}

// =============================================================================
// OUTPUT
// =============================================================================

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}
const OUTPUT_PATH = path.join(OUTPUT_DIR, OUTPUT_FILENAME);

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync(OUTPUT_PATH, buffer);
  console.log('DOCX created:', OUTPUT_PATH);
  console.log('Size:', (buffer.length / 1024).toFixed(0), 'KB');
}).catch(err => {
  console.error('Error generating DOCX:', err);
  process.exit(1);
});
