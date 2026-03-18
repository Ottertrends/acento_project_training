import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
dotenv.config({ override: true });
import { buildPptx, buildPresentationPdfFromPptx } from "./build-pptx-v2.mjs";

// ── Load style tokens ──────────────────────────────────────────────────────
const tokensPath = path.resolve(process.cwd(), "references/style-tokens.json");
const tokens = JSON.parse(await fs.readFile(tokensPath, "utf8"));

// ── Load logo SVG (optional) ────────────────────────────────────────────────
const logoSvgPath = path.resolve(process.cwd(), "references/acento-logo.svg");
let logoSvgRaw = null;
try {
  logoSvgRaw = await fs.readFile(logoSvgPath, "utf8");
  // Remove the opaque beige background fill so the logo shows on any background
  logoSvgRaw = logoSvgRaw.replace(/<path[^>]*fill="#E3E2DB"[^>]*\/>/g, "");
} catch {
  logoSvgRaw = null;
}

const logoSvg = logoSvgRaw
  ? `<div class="logo">${logoSvgRaw}</div>`
  : `<div class="logo"><div><span class="logo-slash"></span><span class="logo-text">Acento</span></div><div class="logo-sub">Project</div></div>`;

// ── Helpers ────────────────────────────────────────────────────────────────
async function readFileSafe(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

// ── Unsplash image fetch ───────────────────────────────────────────────────
async function fetchUnsplashImage(searchTerm) {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) return null;
  try {
    const response = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(searchTerm)}&per_page=1&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${accessKey}` } }
    );
    const data = await response.json();
    const photo = data?.results?.[0];
    if (!photo) return null;
    return photo.urls.regular;
  } catch {
    return null;
  }
}

// ── Ask Claude for image search terms ─────────────────────────────────────
async function getImageTermsFromClaude(client, slides) {
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `For each slide heading below, suggest one specific Unsplash photo search term showing a real professional photo relevant to early childhood education, classrooms, teachers, or children learning. Return ONLY a JSON array of strings, one per slide, no other text, no code fences.

Slides:
${slides.map((s, i) => `${i + 1}. ${s.heading}`).join("\n")}`
      }]
    });
    const raw = msg.content[0]?.text ?? "[]";
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    return slides.map(() => "early childhood classroom teacher");
  }
}

async function repairJsonWithClaude(client, rawText, kind = "object") {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
    temperature: 0,
    system:
      "You are a strict JSON repair tool. Output ONLY valid JSON (no markdown, no commentary). Preserve all data/meaning, but fix any JSON issues (unescaped newlines, quotes, trailing commas, etc.).",
    messages: [
      {
        role: "user",
        content:
          `Fix this invalid JSON and return ONLY valid JSON ${kind}:\n\n` + rawText,
      },
    ],
  });

  return (msg.content[0]?.text ?? "").replace(/```json|```/g, "").trim();
}

async function parseClaudeJson(client, rawText) {
  let text = (rawText ?? "").replace(/```json|```/g, "").trim();

  // If Claude wrapped JSON with extra text, keep the largest {...} block.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    text = text.slice(first, last + 1);
  }

  try {
    return JSON.parse(text);
  } catch {
    // Repair pass handles unescaped newlines/quotes commonly returned by LLMs.
    const repaired = await repairJsonWithClaude(client, rawText, "object");
    return JSON.parse(repaired);
  }
}

// ── System prompt builder ──────────────────────────────────────────────────
function buildSystemPrompt(mainPromptText) {
  return `${mainPromptText.trim()}

RESPONSE FORMAT: You must respond ONLY with a single valid JSON object. No markdown, no code fences, no explanation before or after. Just the raw JSON.
CRITICAL JSON RULES:
- Do NOT include literal newlines inside JSON strings. Keep strings on one line (or use \\n escape sequences).
- Use double quotes for all strings.
- Do not include trailing commas.
- Output must be parseable by JavaScript JSON.parse.
CONTENT SCOPE:
- All trainings must be for preschool settings (primarily ages 3–5) and school staff/teachers unless the user explicitly requests a different age group.

JSON STRUCTURE:
{
  "title": string,
  "courseId": string,
  "estimatedHours": number,
  "assessment": {
    "questions": [
      {
        "question": string,
        "choices": [string, string, string, string]
      }
    ]
  },
  "presentation": {
    "slides": [
      {
        "heading": string,
        "bullets": string[],
        "speakerNotes": string
      }
    ]
  },
  "summary": {
    "targetAudience": string,
    "benefits": {
      "educators": string,
      "directors": string
    },
    "objectives": [string, string, string, string],
    "methodologies": [string, string, string, string],
    "sequence": [
      {
        "module": string,
        "method": string,
        "minutes": number
      }
    ]
  }
}`;
}

// ── Base HTML head with brand tokens ──────────────────────────────────────
function baseHtmlHead() {
  const { colors, fonts, layout, shapes, imagery } = tokens;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=Montserrat:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary:        ${colors.primary};
      --primary-dark:   ${colors.primaryDark};
      --primary-light:  ${colors.primaryLight};
      --secondary:      ${colors.secondary};
      --secondary-dark: ${colors.secondaryDark};
      --secondary-alt:  ${colors.secondaryAlt};
      --bg:             ${colors.background};
      --slide-bg:       ${colors.slideBackground};
      --text:           ${colors.text};
      --text-muted:     ${colors.textMuted};
      --border:         ${colors.border};

      --font-heading:   ${fonts.headingFamily};
      --font-body:      ${fonts.bodyFamily};
      --size-title:     ${fonts.titleSize};
      --size-h2:        ${fonts.h2Size};
      --size-bullet:    ${fonts.bulletBodySize ?? fonts.bulletSize ?? "14px"};
      --size-note:      ${fonts.noteSize};
      --size-caption:   ${fonts.captionSize};
      --lh-title:       ${fonts.lineHeightTitle};
      --lh-body:        ${fonts.lineHeightBody};

      --page-padding:   ${layout.pagePadding};
      --section-px:     ${layout.sectionPaddingX};
      --section-py:     ${layout.sectionPaddingY};
      --section-gap:    ${layout.sectionGap};
      --bullet-gap:     ${layout.bulletGap};
      --radius:         ${layout.borderRadius};
      --slide-max:      ${layout.slideMaxWidthPx}px;

      --circle-op:      ${shapes.cornerCircleOpacity ?? "0.12"};
      --circle-off:     -16px;
      --circle-1-size:  ${shapes.cornerCircle1Size ?? "88px"};
      --circle-2-size:  ${shapes.cornerCircle2Size ?? "60px"};
      --circle-1-color: ${shapes.cornerCircle1Color ?? colors.decorCircle1 ?? colors.primaryLight};
      --circle-2-color: ${shapes.cornerCircle2Color ?? colors.decorCircle2 ?? colors.secondary};
      --circle-2-off:   ${shapes.cornerCircle2Offset ?? "24px"};

      --img-max-h:      ${imagery.imageMaxHeight};
      --img-radius:     ${imagery.imageBorderRadius};
      --img-mb:         ${imagery.imageMarginBottom};
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-body);
      font-size: var(--size-bullet);
      line-height: var(--lh-body);
      padding: var(--page-padding);
    }

    /* ── Logo ── */
    .logo {
      text-align: center;
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 2px solid var(--primary);
    }
    .logo svg {
      width: 160px;
      height: auto;
      display: block;
      margin: 0 auto;
    }
    .logo-slash {
      display: inline-block;
      width: 3px;
      height: 28px;
      background: var(--secondary);
      transform: rotate(15deg) translateY(3px);
      margin-right: 4px;
      border-radius: 2px;
      vertical-align: middle;
    }
    .logo-text {
      font-family: var(--font-heading);
      font-size: 32px;
      color: var(--primary);
      letter-spacing: 2px;
      line-height: 1;
      vertical-align: middle;
    }
    .logo-sub {
      font-family: var(--font-body);
      font-size: var(--size-caption);
      letter-spacing: 5px;
      color: var(--secondary);
      text-transform: uppercase;
      margin-top: 6px;
    }

    /* ── Slide card ── */
    .slide {
      position: relative;
      max-width: var(--slide-max);
      margin: 0 auto var(--section-gap) auto;
      background: var(--slide-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: var(--section-py) var(--section-px);
      overflow: hidden;
      page-break-inside: avoid;
    }
    .slide-circle-1 {
      position: absolute;
      top: var(--circle-off);
      right: var(--circle-off);
      width: var(--circle-1-size);
      height: var(--circle-1-size);
      border-radius: 50%;
      background: var(--circle-1-color);
      opacity: var(--circle-op);
    }
    .slide-circle-2 {
      position: absolute;
      top: var(--circle-2-off);
      right: var(--circle-2-off);
      width: var(--circle-2-size);
      height: var(--circle-2-size);
      border-radius: 50%;
      background: var(--circle-2-color);
      opacity: var(--circle-op);
    }
    .slide-title {
      font-family: var(--font-heading);
      font-size: var(--size-h2);
      color: var(--primary);
      line-height: var(--lh-title);
      margin-bottom: 12px;
      padding-right: 70px;
    }
    .slide-subtitle {
      font-family: var(--font-body);
      font-size: var(--size-bullet);
      font-weight: 700;
      color: var(--secondary);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 8px;
      margin-top: 14px;
    }
    .slide img {
      width: 100%;
      max-height: var(--img-max-h);
      object-fit: cover;
      border-radius: var(--img-radius);
      margin-bottom: var(--img-mb);
    }

    /* ── Bullets ── */
    ul.slide-bullets {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    ul.slide-bullets li {
      display: flex;
      gap: 8px;
      margin-bottom: var(--bullet-gap);
      font-size: var(--size-bullet);
      line-height: var(--lh-body);
      color: var(--text);
    }
    ul.slide-bullets li::before {
      content: "●";
      color: var(--secondary);
      font-size: 7px;
      margin-top: 6px;
      flex-shrink: 0;
    }
    ul.slide-bullets li strong {
      color: var(--primary-dark);
      font-weight: 700;
    }

    /* ── Speaker notes ── */
    .speaker-notes {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px dashed var(--border);
      font-size: var(--size-note);
      color: var(--text-muted);
      line-height: 1.6;
    }
    .speaker-notes .notes-label {
      display: block;
      font-size: 8px;
      font-weight: 700;
      color: var(--secondary-dark);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 4px;
    }

    /* ── Tables ── */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 10px;
      font-size: var(--size-note);
    }
    th {
      background: var(--primary);
      color: white;
      padding: 8px 12px;
      text-align: left;
      font-family: var(--font-body);
      font-weight: 700;
      font-size: var(--size-note);
    }
    td {
      padding: 7px 12px;
      border-bottom: 1px solid var(--border);
      font-size: var(--size-note);
    }
    tr:nth-child(even) td { background: #f5f4f0; }

    /* ── Footer ── */
    .page-footer {
      margin-top: 24px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      font-size: var(--size-caption);
      color: var(--text-muted);
    }
    .footer-legal {
      margin-top: 20px;
      padding: 12px 16px;
      background: #f0ede8;
      border-radius: var(--radius);
      font-size: 7.3pt;
      color: #5E6A71;
      font-style: italic;
      font-weight: 700;
      line-height: 1.6;
      text-align: center;
    }

    /* ── Assessment specific ── */
    .assessment-header {
      margin-bottom: 16px;
      padding-bottom: 10px;
    }
    .assessment-header h1 {
      font-family: 'Montserrat', sans-serif;
      font-size: 10pt;
      font-weight: 700;
      color: #000000;
      margin-bottom: 2px;
    }
    .assessment-header p {
      font-family: 'Montserrat', sans-serif;
      font-size: 10pt;
      font-weight: 700;
      color: #000000;
      margin: 1px 0;
    }
    .questions-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 20pt;
      text-align: justify;
    }
    .question-block {
      margin-bottom: 14pt;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .question-text {
      font-family: 'Montserrat', sans-serif;
      font-size: 9.5pt;
      font-weight: 700;
      color: #000000;
      line-height: 1.4;
      margin-bottom: 4pt;
      text-align: justify;
    }
    .choice {
      font-family: 'Montserrat', sans-serif;
      font-size: 9.5pt;
      font-weight: 400;
      color: #000000;
      line-height: 1.4;
      margin-bottom: 2pt;
      text-align: justify;
    }

    /* ── Summary specific ── */
    .summary-section {
      margin-bottom: var(--section-gap);
      padding: var(--section-py) var(--section-px);
      background: var(--slide-bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
    }
    .summary-section h2 {
      font-family: var(--font-heading);
      font-size: 16px;
      color: var(--primary);
      margin-bottom: 10px;
    }
    .summary-field {
      font-size: var(--size-bullet);
      margin-bottom: 4px;
    }
    .summary-field strong {
      color: var(--primary-dark);
    }
    ul.summary-list {
      list-style: none;
      padding: 0;
      margin: 8px 0 0 0;
    }
    ul.summary-list li {
      display: flex;
      gap: 8px;
      margin-bottom: 6px;
      font-size: var(--size-bullet);
      line-height: var(--lh-body);
    }
    ul.summary-list li::before {
      content: "●";
      color: var(--secondary);
      font-size: 7px;
      margin-top: 6px;
      flex-shrink: 0;
    }
    ul.summary-list li strong {
      color: var(--primary-dark);
      font-weight: 700;
    }
  </style>
</head>`;
}

// ── Document 1: Assessment ─────────────────────────────────────────────────
function buildAssessmentHtml(data) {
  const { title, courseId, assessment } = data;
  // Limit to the 10 most important questions
  const questions = (assessment?.questions ?? []).slice(0, 10);

  // Strip any leading number or letter prefix that Claude may include,
  // since the template adds its own "1." / "A)" prefixes.
  // Uses a loop to handle double-prefixes like "20. 20. Question text"
  function cleanQuestion(text) {
    let t = text.trim();
    let prev;
    do {
      prev = t;
      t = t.replace(/^\d+[.)]\s+/, "").trim();
    } while (t !== prev);
    return t;
  }
  function cleanChoice(text) {
    let t = text.trim();
    let prev;
    do {
      prev = t;
      t = t.replace(/^[A-Da-d][).]\s+/, "").trim();
    } while (t !== prev);
    return t;
  }

  const questionsHtml = questions
    .map(
      (q, idx) => `
    <div class="question-block">
      <div class="question-text">${idx + 1}. ${cleanQuestion(q.question)}</div>
      ${q.choices
        .map(
          (c, ci) => `
        <div class="choice">${String.fromCharCode(65 + ci)}) ${cleanChoice(c)}</div>
      `,
        )
        .join("")}
    </div>
  `,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700;900&display=swap" rel="stylesheet">
  <style>
    @page { margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      background: #E6E5DE;
    }
    body {
      font-family: 'Montserrat', sans-serif;
      font-size: 9.5pt;
      color: #000000;
      padding: 13pt 20pt 21pt 20pt;
    }
    .logo {
      text-align: center;
      margin-bottom: 18pt;
    }
    .logo svg {
      width: 180px;
      height: 180px;
      display: block;
      margin: 0 auto;
    }
    .logo-text {
      font-size: 28pt;
      font-weight: 900;
      color: #4B6A33;
      letter-spacing: 2px;
      line-height: 1;
    }
    .logo-slash {
      display: inline-block;
      width: 3px;
      height: 24px;
      background: #B37C4C;
      transform: rotate(15deg) translateY(3px);
      margin-right: 4px;
      border-radius: 2px;
      vertical-align: middle;
    }
    .logo-sub {
      font-size: 8pt;
      letter-spacing: 5px;
      color: #B37C4C;
      text-transform: uppercase;
      margin-top: 4px;
    }
    .assessment-header {
      margin-bottom: 16pt;
    }
    .assessment-header h1 {
      font-size: 10pt;
      font-weight: 700;
      color: #000000;
      margin-bottom: 2pt;
    }
    .assessment-header p {
      font-size: 10pt;
      font-weight: 700;
      color: #000000;
      margin: 1pt 0;
    }
    .questions-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 20pt;
      text-align: justify;
    }
    .question-block {
      margin-bottom: 14pt;
      break-inside: avoid;
      page-break-inside: avoid;
    }
    .question-text {
      font-size: 9.5pt;
      font-weight: 700;
      color: #000000;
      line-height: 1.4;
      margin-bottom: 4pt;
      text-align: justify;
    }
    .choice {
      font-size: 9.5pt;
      font-weight: 400;
      color: #000000;
      line-height: 1.4;
      margin-bottom: 2pt;
      text-align: justify;
    }
    .footer-legal {
      margin-top: 16pt;
      font-size: 7.3pt;
      color: #5E6A71;
      font-style: italic;
      font-weight: 700;
      line-height: 1.6;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="logo">
    ${logoSvg.replace('<div class="logo">', "").replace("</div>", "")}
  </div>

  <div class="assessment-header">
    <h1>Course Assessment: ${title}</h1>
    <p>Course ID: ${courseId}</p>
    <p>Total Points: 100</p>
  </div>

  <div class="questions-grid">
    ${questionsHtml}
  </div>

  <div class="footer-legal">
    This assessment is administered automatically via the Acento Project Digital Learning Portal.
    The system utilizes real-time grading logic to ensure each participant achieves a minimum
    passing score of 80%. Upon successful completion, the platform automatically generates a
    verified Certificate of Completion.
  </div>
</body>
</html>`;
}

// ── Document 2: Presentation ───────────────────────────────────────────────
function buildPresentationHtml(data) {
  const { title, courseId, presentation } = data;
  const slides = presentation?.slides ?? [];

  const slidesHtml = slides
    .map(
      (s, idx) => `
      <div class="slide">
        <div class="slide-circle-1"></div>
        <div class="slide-circle-2"></div>
        ${s.imageUrl ? `<img src="${s.imageUrl}" alt="${s.heading}" />` : ""}
        <div class="slide-title">Slide ${idx + 1}: ${s.heading}</div>
        <ul class="slide-bullets">
          ${(s.bullets || [])
            .map((b) => {
              const parts = b.split(":");
              return parts.length > 1
                ? `<li><strong>${parts[0]}:</strong>${parts.slice(1).join(":")}</li>`
                : `<li>${b}</li>`;
            })
            .join("")}
        </ul>
        <div class="speaker-notes">
          <strong>Speaker Notes</strong><br/>${s.speakerNotes}
        </div>
      </div>
    `,
    )
    .join("");

  return `${baseHtmlHead()}
<body>
  ${logoSvg}

  <div class="slide">
    <div class="slide-circle-1"></div>
    <div class="slide-circle-2"></div>
    <div class="slide-title" style="font-size: var(--size-title); text-align: center; padding-right: 0;">
      ${title}
    </div>
    <p style="text-align:center; color: var(--secondary); font-weight:600; margin-top:8px;">
      Professional Training for Early Childhood Educators &amp; Directors
    </p>
    <p style="text-align:center; color: var(--text-muted); font-size: var(--size-note); margin-top:6px;">
      Course ID: ${courseId} &nbsp;|&nbsp; Instructor: Cristina Galvan, B.A. Psychopedagogy &nbsp;|&nbsp; Self-Paced Online
    </p>
  </div>

  ${slidesHtml}

  <div class="page-footer">
    <span>Supplemental Documents / Presentation / Acento Project</span>
    <span>hello@acentoproject.com &nbsp;|&nbsp; acentoproject.com</span>
  </div>
</body>
</html>`;
}

// ── Document 3: Summary ────────────────────────────────────────────────────
function buildSummaryHtml(data) {
  const { title, courseId, estimatedHours, summary } = data;
  const seq = summary?.sequence ?? [];
  const totalMinutes = seq.reduce((sum, r) => sum + (r.minutes || 0), 0);
  const totalHoursLabel =
    estimatedHours % 1 === 0
      ? `${estimatedHours} hours`
      : `${estimatedHours} hours`;

  // ── Objectives ────────────────────────────────────────────────────────
  const objectivesHtml = (summary?.objectives ?? [])
    .map((o) => {
      const colonIdx = o.indexOf(" ");
      const verb = o.substring(0, colonIdx);
      const rest = o.substring(colonIdx);
      return `<li><strong>${verb}</strong>${rest}</li>`;
    })
    .join("");

  // ── Methodologies ─────────────────────────────────────────────────────
  const methodsHtml = (summary?.methodologies ?? [])
    .map((m) => {
      const colonIdx = m.indexOf(":");
      if (colonIdx > 0 && colonIdx < 60) {
        const label = m.substring(0, colonIdx);
        const rest = m.substring(colonIdx + 1);
        return `<li><strong>${label}:</strong> ${rest.trim()}</li>`;
      }
      return `<li>${m}</li>`;
    })
    .join("");

  // ── Sequence table rows ───────────────────────────────────────────────
  const seqRows = seq
    .map(
      (row) => `
    <tr>
      <td>${row.module}</td>
      <td>${row.method}</td>
      <td>${row.minutes} min</td>
    </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap" rel="stylesheet">
  <style>
    @page { margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      width: 100%;
      background: #E6E5DE;
    }

    body {
      font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif;
      font-size: 12pt;
      color: #5E6A71;
      padding: 20pt 20pt 20pt 20pt;
    }

    /* ── Logo ── */
    .logo {
      text-align: center;
      margin-bottom: 20pt;
    }
    .logo svg {
      width: 180px;
      height: 180px;
      display: block;
      margin: 0 auto;
    }

    /* ── Header fields ── */
    .header-fields {
      margin-bottom: 16pt;
    }
    .header-fields p {
      font-size: 12pt;
      font-weight: 700;
      color: #5E6A71;
      line-height: 1.6;
      margin: 0;
    }

    /* ── Section headings ── */
    .section-heading {
      font-size: 12pt;
      font-weight: 700;
      color: #5E6A71;
      margin-top: 14pt;
      margin-bottom: 6pt;
    }

    /* ── Body text ── */
    p.body-text {
      font-size: 12pt;
      font-weight: 400;
      color: #5E6A71;
      line-height: 1.55;
      text-align: justify;
    }

    /* ── Bullet lists ── */
    ul.summary-list {
      list-style: disc;
      padding-left: 18pt;
      margin: 0;
    }
    ul.summary-list li {
      font-size: 12pt;
      color: #5E6A71;
      line-height: 1.55;
      margin-bottom: 4pt;
      text-align: justify;
    }
    ul.summary-list li strong {
      font-weight: 700;
      color: #5E6A71;
    }

    /* ── Sequence table ── */
    .table-title {
      font-size: 13pt;
      font-weight: 700;
      color: #F4F1EA;
      background: #5E6A71;
      padding: 6pt 10pt;
      text-align: center;
      margin-top: 14pt;
      width: 52%;
      margin-left: auto;
    }

    table.seq-table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 0;
      font-size: 12pt;
      border: 1px solid #000000;
    }
    table.seq-table thead tr th {
      background: #5E6A71;
      color: #E6E5DE;
      font-weight: 400;
      font-size: 13pt;
      padding: 8pt 10pt;
      text-align: center;
      border: 1px solid #000000;
    }
    table.seq-table tbody tr td {
      background: #D9D9D9;
      color: #000000;
      font-size: 12pt;
      font-weight: 400;
      padding: 8pt 10pt;
      vertical-align: top;
      border: 1px solid #000000;
    }
    table.seq-table tfoot tr td {
      background: #5E6A71;
      color: #F4F1EA;
      font-weight: 700;
      font-size: 13pt;
      padding: 8pt 10pt;
      text-align: center;
      border: 1px solid #000000;
    }
  </style>
</head>
<body>

  <div class="logo">
    ${logoSvg.replace('<div class="logo">', '').replace('</div>', '')}
  </div>

  <div class="header-fields">
    <p><strong>Title:</strong> ${title}</p>
    <p><strong>Total Hours:</strong> ${totalHoursLabel}</p>
    <p><strong>Format:</strong> Self-Paced Online</p>
    <p><strong>Instructor:</strong> Cristina Galvan B.A. Psychopedagogy</p>
  </div>

  <p class="section-heading"><strong>Target Audience:</strong></p>
  <p class="body-text">${summary?.targetAudience ?? ""}</p>

  <p class="section-heading"><strong>Benefits to Target Audience:</strong></p>
  <ul class="summary-list">
    <li><strong>Educators:</strong> ${summary?.benefits?.educators ?? ""}</li>
    <li><strong>Administrators/Directors:</strong> ${summary?.benefits?.directors ?? ""}</li>
  </ul>

  <p class="section-heading"><strong>Competency-Based Learning Objectives:</strong></p>
  <ul class="summary-list">${objectivesHtml}</ul>

  <p class="section-heading"><strong>Training Methodologies/Strategies Utilized:</strong></p>
  <ul class="summary-list">${methodsHtml}</ul>

  <div class="table-title">Sequence of Training (Desglose de ${estimatedHours} Horas)</div>
  <table class="seq-table">
    <thead>
      <tr>
        <th style="width:39%;">Content</th>
        <th style="width:46%;">Methods/Activities</th>
        <th style="width:15%;">Time Allotment</th>
      </tr>
    </thead>
    <tbody>
      ${seqRows}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="2" style="text-align:right; font-weight:700;">
          <strong>Total Length: ${totalHoursLabel} (${totalMinutes} min)</strong>
        </td>
        <td></td>
      </tr>
    </tfoot>
  </table>

</body>
</html>`;
}

// ── Main pipeline ──────────────────────────────────────────────────────────
async function generatePdfs(courseId, userPrompt) {
  const projectRoot = path.resolve(process.cwd());
  const mainPromptPath = path.join(projectRoot, "Main Prompt.txt");
  const mainPromptText = await readFileSafe(mainPromptPath);

  if (!mainPromptText) {
    throw new Error(`Could not read Main Prompt.txt at ${mainPromptPath}`);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Check your .env file.");
  }

  const client = new Anthropic({ apiKey });
  const system = buildSystemPrompt(mainPromptText);

  // Step 1 — Generate content with Claude
  console.log("  Calling Claude to generate training content...");
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 16000,
    temperature: 0.2,
    system,
    messages: [{
      role: "user",
      content: `Course ID: ${courseId}

New Training:
${userPrompt}

Respond ONLY with valid JSON. No markdown, no code fences.`
    }]
  });

  const rawText = msg.content[0]?.text ?? "";
  let data;
  try {
    data = await parseClaudeJson(client, rawText);
  } catch (e) {
    console.error("Claude returned invalid JSON (and repair failed).");
    console.error("Raw response (first 1500 chars):\n", rawText.slice(0, 1500));
    throw e;
  }

  // Step 2 — Fetch images for slides
  console.log("  Fetching images from Unsplash...");
  const slides = data.presentation?.slides ?? [];
  const imageTerms = await getImageTermsFromClaude(client, slides);
  const imageUrls = await Promise.all(
    imageTerms.map(term => fetchUnsplashImage(term))
  );
  slides.forEach((slide, i) => {
    slide.imageUrl = imageUrls[i] ?? null;
  });

  // Step 3 — Render PDFs
  console.log("  Rendering PDFs with Puppeteer & PPTX pipeline...");
  const outputDir = path.join(projectRoot, "output", courseId);
  await fs.mkdir(outputDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    async function htmlToPdf(html, filename) {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdf = await page.pdf({
        format: "Letter",
        printBackground: true,
        margin: { top: "0", bottom: "0", left: "0", right: "0" }
      });
      await page.close();
      const filePath = path.join(outputDir, filename);
      await fs.writeFile(filePath, pdf);
      return filePath;
    }

    const assessmentPath  = await htmlToPdf(buildAssessmentHtml(data),  `${courseId}_Assessment.pdf`);
    console.log(`  ✓ Assessment saved`);

    // Presentation via PPTX → slide screenshots → PDF with notes handled by Python/ReportLab
    const pptxPath = await buildPptx(data, outputDir);
    const presentationPath = await buildPresentationPdfFromPptx(data, pptxPath, outputDir);
    console.log(`  ✓ Presentation saved`);

    const summaryPath = await htmlToPdf(buildSummaryHtml(data), `${courseId}_Summary.pdf`);
    console.log(`  ✓ Summary saved`);

    return { assessmentPath, presentationPath, summaryPath };
  } finally {
    await browser.close();
  }
}

// ── Entry point ────────────────────────────────────────────────────────────
async function main() {
  const [, , courseIdArg, promptFileArg] = process.argv;

  if (!courseIdArg || !promptFileArg) {
    console.error("Usage: node scripts/generate-local.mjs <COURSE_ID> <PROMPT_FILE>");
    console.error("Example: node scripts/generate-local.mjs AP-02 AP-02.txt");
    process.exit(1);
  }

  const promptPath = path.resolve(process.cwd(), promptFileArg);
  const promptText = await readFileSafe(promptPath);

  if (!promptText) {
    console.error(`Could not read prompt file: ${promptPath}`);
    process.exit(1);
  }

  console.log(`\nAcento Project — Generating training: ${courseIdArg}`);
  console.log("─".repeat(50));

  const result = await generatePdfs(courseIdArg, promptText);

  console.log("\n✓ Done! Files saved to:");
  console.log(`  ${result.assessmentPath}`);
  console.log(`  ${result.presentationPath}`);
  console.log(`  ${result.summaryPath}`);
  console.log("\nEmpowering Educators, Nurturing Futures.\n");
}

main().catch(err => {
  console.error("\n✗ Error:", err.message);
  process.exit(1);
});
