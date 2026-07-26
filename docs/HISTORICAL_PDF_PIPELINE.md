# Historical PDF Pipeline

## Runtime dependencies

The PDF worker uses the operating system's Poppler and Tesseract tools:

- `pdftotext` for layout-preserving embedded text extraction.
- `pdfinfo` for a bounded page count.
- `pdftoppm` for rendering one page at a time.
- `tesseract` with `chi_sim+eng` language data for scanned pages.

The cache root is configured with `HISTORICAL_CACHE_DIR`. Production uses
`/var/lib/policy-monitor/historical-cache`, which is already inside the systemd
service's writable path.

## Durable stages

1. Download only HTTPS `.gov.cn` content with public DNS answers, bounded redirects,
   an 80 MiB streaming limit, PDF MIME validation, and `%PDF-` byte validation.
2. Store source bytes as `pdf/<sha256>.pdf` and record a `source_pdf` artifact.
3. Prefer `pdftotext -layout`. Use OCR only when the extracted text does not contain
   enough Chinese source text to be useful.
4. OCR at most the configured page budget. Each page is written atomically and
   recorded as an `ocr_page` artifact before the next page starts.
5. Combine complete page text, retain form-feed page boundaries, and record either
   an `embedded_text` or `ocr_text` artifact.
6. Split an issue on conservative policy-title headings. Record page ranges and
   candidate checksums in a `segmentation` artifact.
7. Insert deterministic child rows at `needs_review`. No public document, analysis,
   forecast, or notification is created.

An interrupted run resumes from cached source bytes and completed page files. A
failed tool or network request remains in `manual_review` with exponential retry.
An incomplete OCR run is retried after one hour; unresolved segmentation is retried
after 24 hours and remains private.

## Commands

```bash
node collector/src/cli.js --historical-pdf-process \
  --adaptive-load --min-items 1 --max-items 5 \
  --ocr-page-budget 20 --delay-ms 5000
```

The historical systemd service runs discovery, HTML routing, and PDF processing in
that order during each hourly window.
