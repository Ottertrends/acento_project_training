import sys
import os
import json
import subprocess
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from reportlab.lib.colors import HexColor
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT

SOFFICE_EXE = r"C:\Program Files\LibreOffice\program\soffice.exe"
PDFTOPPM_EXE = r"C:\Users\ferna\Tools\poppler-win\poppler-25.12.0\Library\bin\pdftoppm.exe"


def pptx_to_images(pptx_path, tmp_dir):
  # Remove any stale PDFs from a previous run so we always find the right file.
  for old in os.listdir(tmp_dir):
    if old.endswith(".pdf"):
      os.remove(os.path.join(tmp_dir, old))

  # Convert PPTX to PDF via LibreOffice
  subprocess.check_call([
    SOFFICE_EXE,
    "--headless",
    "--convert-to",
    "pdf",
    "--outdir",
    tmp_dir,
    pptx_path,
  ])

  # LibreOffice names the output after the input file — find it dynamically.
  pdf_files = [f for f in os.listdir(tmp_dir) if f.endswith(".pdf")]
  if not pdf_files:
    raise FileNotFoundError(f"LibreOffice did not produce a PDF in {tmp_dir}")
  pdf_path = os.path.join(tmp_dir, pdf_files[0])

  # Convert PDF pages to images using pdftoppm
  base = os.path.join(tmp_dir, "slide")
  subprocess.check_call([
    PDFTOPPM_EXE,
    "-jpeg",
    "-r",
    "150",
    pdf_path,
    base,
  ])

  # Collect image paths in order
  images = sorted(
    [
      os.path.join(tmp_dir, f)
      for f in os.listdir(tmp_dir)
      if f.startswith("slide-") and f.endswith(".jpg")
    ]
  )
  return images


def escape_for_paragraph(text):
  if text is None:
    return ""
  # Keep it simple: escape HTML-sensitive chars for Paragraph.
  return (
    str(text)
    .replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\n", "<br/>")
  )


def build_pdf_from_images(image_paths, output_pdf, notes_pages):
  c = canvas.Canvas(output_pdf, pagesize=A4)
  width, height = A4
  margin = 36  # pt
  footer_y = 18
  total_pages = len(image_paths)

  note_style = ParagraphStyle(
    name="notes",
    fontName="Helvetica",
    fontSize=9,
    leading=11,
    textColor=HexColor("#1F2937"),
    alignment=TA_LEFT,
  )

  label_style = ParagraphStyle(
    name="label",
    fontName="Helvetica-Bold",
    fontSize=8,
    leading=10,
    textColor=HexColor("#1F2937"),
    alignment=TA_LEFT,
  )

  for page_index, img_path in enumerate(image_paths):
    img = ImageReader(img_path)
    iw, ih = img.getSize()
    # Fit slide image to available width, keep aspect
    avail_w = width - 2 * margin
    scale = avail_w / iw
    img_w = avail_w
    img_h = ih * scale

    # Slide image at top
    img_x = margin
    img_y = height - margin - img_h
    c.drawImage(img, img_x, img_y, width=img_w, height=img_h)

    # Notes below image
    notes_text = ""
    if page_index < len(notes_pages):
      notes_text = notes_pages[page_index] or ""

    notes_top = img_y - 10
    notes_bottom_limit = margin
    notes_available_h = max(0, notes_top - notes_bottom_limit)

    c.saveState()
    label = Paragraph("Speaker Notes", label_style)
    # Draw label first
    label_w, label_h = label.wrap(avail_w, notes_available_h)
    label.drawOn(c, img_x, notes_top - label_h)

    p = Paragraph(escape_for_paragraph(notes_text), note_style)
    # Draw paragraph within remaining height; Paragraph will clip if needed.
    rem_h = max(0, notes_available_h - label_h - 4)
    p_w, p_h = p.wrap(avail_w, rem_h)
    p.drawOn(c, img_x, notes_top - label_h - 4 - p_h)
    c.restoreState()

    # Footer
    left = "Supplemental Documents / PowerPoint Presentation/ Acento Project"
    right = f"Page {page_index + 1} of {total_pages}"
    c.setFont("Helvetica", 7)
    c.drawString(margin, footer_y, left)
    c.drawRightString(width - margin, footer_y, right)

    c.showPage()

  c.save()


def main():
  if len(sys.argv) < 4:
    print("Usage: python build_presentation_pdf.py <input.pptx> <output.pdf> <notes.json>")
    sys.exit(1)

  pptx_path = os.path.abspath(sys.argv[1])
  output_pdf = os.path.abspath(sys.argv[2])
  notes_path = os.path.abspath(sys.argv[3])
  tmp_dir = os.path.join(os.path.dirname(output_pdf), "_slides_tmp")
  os.makedirs(tmp_dir, exist_ok=True)

  notes_payload = {}
  try:
    with open(notes_path, "r", encoding="utf-8") as f:
      notes_payload = json.load(f)
  except Exception:
    notes_payload = {}

  notes_pages = notes_payload.get("notesPages", [])

  images = pptx_to_images(pptx_path, tmp_dir)
  build_pdf_from_images(images, output_pdf, notes_pages)


if __name__ == "__main__":
  main()

