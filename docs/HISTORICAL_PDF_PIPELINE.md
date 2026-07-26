# Historical PDF Pipeline

## Runtime dependencies

The PDF worker uses the operating system's Poppler and Tesseract tools:

- `pdftotext` for layout-preserving embedded text extraction.
- `pdfinfo` for a bounded page count.
- `pdftoppm` for rendering one page at a time.
- `tesseract` with `chi_sim+chi_tra+eng` language data for modern and early
  traditional-character gazettes.

The cache root is configured with `HISTORICAL_CACHE_DIR`. Production uses
`/var/lib/policy-monitor/historical-cache`, which is already inside the systemd
service's writable path.

On Alibaba Cloud Linux, install the matching traditional model before deployment:

```bash
dnf install -y tesseract-langpack-chi_tra
```

The production verifier fails closed unless `chi_sim`, `chi_tra`, and `eng` are all
reported by `tesseract --list-langs`.

## Durable stages

1. Download only HTTPS `.gov.cn` content with public DNS answers, bounded redirects,
   an 80 MiB streaming limit, PDF MIME validation, and `%PDF-` byte validation.
2. Store source bytes as `pdf/<sha256>.pdf` and record a `source_pdf` artifact.
3. Prefer `pdftotext -layout`. Use OCR only when the extracted text does not contain
   enough Chinese source text to be useful.
4. OCR at 300 DPI with automatic page layout (`--psm 3`) and the LSTM engine
   (`--oem 1`), at most the configured page budget. Each page is written atomically
   and recorded as an `ocr_page` artifact. Production processes at most two pages
   concurrently; the systemd unit retains a 150% CPU quota and 768 MiB memory cap.
5. Combine complete page text, retain form-feed page boundaries, and record either
   an `embedded_text` or `ocr_text` artifact.
6. Split an issue on conservative policy-title headings. Record page ranges and
   candidate checksums in a `segmentation` artifact.
7. Insert deterministic child rows at `manual_review`. OCR is candidate discovery,
   not authoritative transcription: every child stays there until a structured
   review compares its title and text with the cited official PDF pages. No public
   document, analysis, forecast, or notification is created.

The page cache is namespaced by a checksum of language, DPI, PSM, OEM, and profile
version. Configuration upgrades therefore cannot silently reuse older OCR text. An
interrupted run resumes from cached source bytes and completed pages for the exact
same profile. A
failed tool or network request remains in `manual_review` with exponential retry.
An incomplete OCR run is retried after one hour; unresolved segmentation is retried
after 24 hours and remains private.

## Commands

```bash
node collector/src/cli.js --historical-pdf-process \
  --adaptive-load --min-items 1 --max-items 5 \
  --ocr-page-budget 20 --ocr-languages chi_sim+chi_tra+eng \
  --ocr-dpi 300 --ocr-psm 3 --ocr-oem 1 \
  --ocr-page-concurrency 2 --delay-ms 5000
```

The historical systemd service runs discovery, HTML routing, and PDF processing in
that order during each hourly window.
