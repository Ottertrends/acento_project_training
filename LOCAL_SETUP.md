# Acento Generator — Local Training Pipeline Setup (Windows)

This repo generates 3 branded PDFs per training topic:
- Assessment PDF (HTML → PDF via Puppeteer)
- Presentation PDF (PPTX → slide screenshots → PDF via LibreOffice + Poppler + ReportLab)
- Training Summary PDF (HTML → PDF via Puppeteer)

## 1) One-time setup (admin PowerShell)

Open **PowerShell as Administrator** and run:

```powershell
# Python
winget install Python.Python.3.13

# LibreOffice
winget install TheDocumentFoundation.LibreOffice

# Poppler (recommended via Scoop)
winget install Scoop.Scoop
scoop install poppler
```

Close and reopen the terminal.

## 2) Verify required executables

Run these checks from any PowerShell:

```powershell
where soffice
where pdftoppm
```

The script auto-detects both tools (and also checks common install locations).
If detection fails, you can set environment variables:
`SOFFICE_EXE` and `PDFTOPPM_EXE` to the full `.exe` paths.

## 3) Install Python dependency

```powershell
pip install reportlab
```

## 4) Clone + install Node dependencies

From your GitHub clone folder:

```powershell
cd path\to\acento-generator
npm install
```

## 5) Provide API keys + prompt reference

### 5.1 Create environment file

In `acento-generator\`, create `.env.local` with:

```env
ANTHROPIC_API_KEY=your_anthropic_key
UNSPLASH_ACCESS_KEY=your_unsplash_key
```

### 5.2 Place `Main Prompt.txt` for Claude

`Main Prompt.txt` is included in this repo (repo root / same folder as `package.json`).

## 6) Run a test generation

From `acento-generator/`:

```powershell
node scripts/generate-local.mjs AP-02 AP-02.txt
```

Generated files appear in:
`output\<COURSE_ID>\`

Example:
`output\AP-02\AP-02_Assessment.pdf`
`output\AP-02\AP-02_Presentation.pdf`
`output\AP-02\AP-02_Summary.pdf`

## 7) Poppler path catch (only if needed)

If the presentation pipeline fails with "pdftoppm.exe not found", run:

```powershell
Get-ChildItem $env:USERPROFILE -Recurse -Filter pdftoppm.exe -ErrorAction SilentlyContinue | Select-Object -First 5 FullName
```

Then set environment variables for the current terminal session:

```powershell
$env:SOFFICE_EXE="C:\Program Files\LibreOffice\program\soffice.exe"
$env:PDFTOPPM_EXE="C:\path\to\pdftoppm.exe"
```

and rerun:
```powershell
node scripts/generate-local.mjs AP-02 AP-02.txt
```

