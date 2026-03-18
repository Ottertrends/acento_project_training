import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PptxGenJS from "pptxgenjs";
import { spawn } from "node:child_process";

// ── Slide dimensions ───────────────────────────────────────────────────────
// Reference PPTX: 18288000 × 10287000 EMU = 20 × 11.25 inches
const SLIDE_W = 20;
const SLIDE_H = 11.25;

// ── Brand colors (from style-tokens.json and reference XML) ───────────────
const C_BG     = "E6E5DE";  // warm beige slide background
const C_GREEN  = "4A6631";  // dark green — headings
const C_BROWN  = "B37C4C";  // warm brown — subtitle / course info
const C_ORANGE = "C06C4D";  // orange-red — bullet labels + text
const C_CIRCLE = "8A9A5B";  // sage green — decorative circle

// ── Decorative circle position (from slide 3 XML: top-right, partially off) ─
// Converted from EMU: x=14955552/914400=16.35in, y=-729187/914400=-0.80in
// Group size: 3086100/914400=3.37in
const CIRCLE_X = 16.35;
const CIRCLE_Y = -0.80;
const CIRCLE_D =  3.37;

// ── Content slide layout positions (from slide 3 XML) ─────────────────────
// Heading: x=1027297/914400=1.12, y=650585/914400=0.71, w=5174556/914400=5.66
// Bullets:  x=1027297/914400=1.12, y=3459480/914400=3.78, w=6819174/914400=7.45
// Image:    x=9625342/914400=10.52, y=2356913/914400=2.58, w=7884353/914400=8.62, h=5252950/914400=5.74
const HEADING_X = 1.12; const HEADING_Y = 0.71; const HEADING_W = 9.0;  const HEADING_H = 2.50;
const BULLET_X  = 1.12; const BULLET_Y  = 3.50; const BULLET_W  = 8.80; const BULLET_H  = 6.80;
const IMG_X     = 10.52; const IMG_Y    = 1.50;  const IMG_W    = 8.80;  const IMG_H    = 8.50;

// ── Image downloader ───────────────────────────────────────────────────────
async function downloadImage(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download image (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
}

// ── Add decorative circle to a slide ──────────────────────────────────────
// pptx is passed so we can reference pptx.shapes.OVAL at call time.
function addDecorCircle(pptx, sld) {
  sld.addShape(pptx.shapes.OVAL, {
    x: CIRCLE_X, y: CIRCLE_Y,
    w: CIRCLE_D, h: CIRCLE_D,
    fill: { color: C_CIRCLE },
    line: { color: C_CIRCLE },
  });
}

// ── Build rich-text array for bullet points ────────────────────────────────
// Splits on first ":" so the label is bold and the description is regular.
// Both label and description use color C_ORANGE per the reference design.
// Each paragraph starts with bullet:true on its first run, and ends with
// breakLine:true on its last run (except for the final bullet paragraph).
function buildBulletRichText(bullets) {
  const richText = [];

  for (let i = 0; i < bullets.length; i++) {
    const b          = bullets[i];
    const isLast     = i === bullets.length - 1;
    const colonIdx   = b.indexOf(":");
    const hasLabel   = colonIdx > 0 && colonIdx < 70;

    if (hasLabel) {
      const label = b.substring(0, colonIdx + 1);
      const desc  = b.substring(colonIdx + 1).trim();

      // First run of paragraph: bullet marker + bold label
      richText.push({
        text: label + " ",
        options: { bold: true, bullet: true },
      });

      // Second run: regular description — add breakLine unless last bullet
      richText.push({
        text: desc,
        options: { bold: false, breakLine: !isLast },
      });
    } else {
      // Single-run bullet — add breakLine unless last bullet
      richText.push({
        text: b,
        options: { bold: false, bullet: true, breakLine: !isLast },
      });
    }
  }

  return richText;
}

// ── Logo watermark path (from reference PPTX: x=-0.37,y=8.67,w=11.57,h=1.98,rot=-16.2deg) ─
const LOGO_WM_PATH = fileURLToPath(new URL("../references/acento-logo-watermark.png", import.meta.url));

// ── Add tilted logo watermark to a slide (matches reference slide layout) ─
async function addLogoWatermark(sld) {
  try {
    await fs.access(LOGO_WM_PATH);
    sld.addImage({
      path: LOGO_WM_PATH,
      x: -0.37, y: 8.67, w: 11.57, h: 1.98,
      rotate: -16,
    });
  } catch {
    // Logo file not found — skip silently
  }
}

// ── Main PPTX builder ──────────────────────────────────────────────────────
export async function buildPptx(data, outputDir) {
  const { title, courseId, presentation } = data;
  const slides = presentation?.slides ?? [];

  const pptx = new PptxGenJS();

  // Custom layout matching the reference PPTX (18288000 × 10287000 EMU)
  pptx.defineLayout({ name: "ACENTO_20x11", width: SLIDE_W, height: SLIDE_H });
  pptx.layout = "ACENTO_20x11";

  // ── SLIDE 1: Brand Cover ─────────────────────────────────────────────────
  // Full-slide Unsplash photo for the cover (uses slides[0] image).
  // A semi-transparent green overlay + wordmark is placed on top.
  const cover = pptx.addSlide();
  cover.background = { color: C_BG };

  if (slides[0]?.imageUrl) {
    const coverPath = path.join(outputDir, "_pptx_cover.jpg");
    try {
      await downloadImage(slides[0].imageUrl, coverPath);
      cover.addImage({ path: coverPath, x: 0, y: 0, w: SLIDE_W, h: SLIDE_H });
    } catch {}
  }

  // Green overlay rectangle (60% opacity) for legibility
  cover.addShape(pptx.shapes.RECTANGLE, {
    x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
    fill: { color: C_GREEN, transparency: 45 },
    line: { color: C_GREEN, transparency: 45 },
  });

  // Wordmark
  cover.addText("Acento Project", {
    x: 2, y: SLIDE_H / 2 - 1.2, w: 16, h: 1.8,
    align: "center", valign: "middle",
    fontSize: 80, bold: true, fontFace: "Playfair Display",
    color: "FFFFFF",
  });

  // Tagline
  cover.addText("Empowering Educators, Nurturing Futures.", {
    x: 3, y: SLIDE_H / 2 + 0.8, w: 14, h: 0.7,
    align: "center", valign: "middle",
    fontSize: 22, bold: false, fontFace: "Montserrat",
    color: "E6E5DE",
  });

  // ── SLIDE 2: Title Slide ─────────────────────────────────────────────────
  // Beige background, decorative circle, training title (56pt, centered),
  // subtitle (28pt, centered), course info strip.
  // Photo from slides[1] fills the bottom-right area.
  const titleSld = pptx.addSlide();
  titleSld.background = { color: C_BG };
  addDecorCircle(pptx, titleSld);

  // Bottom-right photo (use first content slide's image so it's unique)
  if (slides[1]?.imageUrl) {
    const titlePhotoPath = path.join(outputDir, "_pptx_title_photo.jpg");
    try {
      await downloadImage(slides[1].imageUrl, titlePhotoPath);
      titleSld.addImage({ path: titlePhotoPath, x: 6.29, y: 5.80, w: 7.41, h: 4.94 });
    } catch {}
  }

  // Training title — Playfair Display Bold, 56pt, dark green, centered
  titleSld.addText(title, {
    x: 2.39, y: 2.40, w: 15.22, h: 2.20,
    align: "center", valign: "middle",
    fontSize: 56, bold: true, fontFace: "Playfair Display",
    color: C_GREEN,
    autoFit: true,
  });

  // Subtitle
  titleSld.addText("Professional Training for Early Childhood Educators & Directors.", {
    x: 3.52, y: 4.80, w: 12.96, h: 0.80,
    align: "center", valign: "middle",
    fontSize: 28, bold: true, fontFace: "Montserrat",
    color: C_BROWN,
  });

  // Course info row (from slides[0].bullets: course ID, instructor, format…)
  const infoBullets = slides[0]?.bullets ?? [];
  if (infoBullets.length) {
    titleSld.addText(infoBullets.join("  |  "), {
      x: 2, y: 5.80, w: 4, h: 1.20,
      align: "left", valign: "top",
      fontSize: 16, bold: false, fontFace: "Montserrat",
      color: "5E6A71",
      wrap: true,
    });
  }

  // ── SLIDES 3+: Content Slides ────────────────────────────────────────────
  // Layout (from reference slide 3): decorative circle top-right,
  // left column = heading (42pt) + bullets (24pt), right column = photo.
  for (let i = 1; i < slides.length; i++) {
    const s   = slides[i];
    const sld = pptx.addSlide();
    sld.background = { color: C_BG };
    addDecorCircle(pptx, sld);

    // Right-side photo
    if (s.imageUrl) {
      const imgFile = path.join(
        outputDir,
        `_pptx_${encodeURIComponent(s.heading).slice(0, 20)}.jpg`,
      );
      try {
        await downloadImage(s.imageUrl, imgFile);
        sld.addImage({ path: imgFile, x: IMG_X, y: IMG_Y, w: IMG_W, h: IMG_H });
      } catch {}
    }

    // Heading — Playfair Display Bold, 42pt, dark green, left-aligned
    sld.addText(s.heading, {
      x: HEADING_X, y: HEADING_Y, w: HEADING_W, h: HEADING_H,
      align: "left", valign: "top",
      fontSize: 42, bold: true, fontFace: "Playfair Display",
      color: C_GREEN,
      autoFit: true,
    });

    // Optional sub-label (detected as a bullet starting with the pattern "Label:")
    // already handled by buildBulletRichText — first bullet will be bold-labeled.

    // Bullets — Montserrat 24pt, orange-red (#C06C4D), bold labels
    const bullets = s.bullets || [];
    if (bullets.length > 0) {
      sld.addText(buildBulletRichText(bullets), {
        x: BULLET_X, y: BULLET_Y, w: BULLET_W, h: BULLET_H,
        align: "left", valign: "top",
        fontSize: 24, fontFace: "Montserrat",
        color: C_ORANGE,
        lineSpacingMultiple: 1.3,
      });
    }

    // Tilted logo watermark at bottom-left (matches reference PPTX)
    await addLogoWatermark(sld);
  }

  const fileName = `${courseId}_Presentation.pptx`;
  const filePath  = path.join(outputDir, fileName);
  await pptx.writeFile({ fileName: filePath });
  return filePath;
}

// ── PDF builder (unchanged — Python/ReportLab pipeline) ───────────────────
export async function buildPresentationPdfFromPptx(data, pptxPath, outputDir) {
  const courseId = data.courseId ?? data.course_id ?? "course";
  const pdfPath  = path.join(outputDir, `${courseId}_Presentation.pdf`);

  const slides = data.presentation?.slides ?? [];

  // Notes array: cover (empty), title slide, then all content slides
  const notesPages = [
    "",                                                    // cover slide
    slides[0]?.speakerNotes ?? "",                         // title slide
    ...slides.slice(1).map((s) => s.speakerNotes ?? ""),  // content slides
  ];

  const notesPath = path.join(outputDir, `${courseId}_presentation_notes.json`);
  await fs.writeFile(notesPath, JSON.stringify({ notesPages }), "utf8");

  await new Promise((resolve, reject) => {
    const child = spawn(
      "python",
      [
        path.join(process.cwd(), "scripts", "build_presentation_pdf.py"),
        pptxPath,
        pdfPath,
        notesPath,
      ],
      { stdio: "inherit" },
    );
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Python build_presentation_pdf.py exited with ${code}`)),
    );
  });

  return pdfPath;
}
