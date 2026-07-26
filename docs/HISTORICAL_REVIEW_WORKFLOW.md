# Historical Human Review Workflow

OCR discovers candidates; it is not authoritative policy text. A candidate may
enter the private `ready` stage only after its transcription and claims are compared
with official source pages and submitted through the structured review validator.

## Export

```bash
node collector/src/cli.js \
  --historical-review-export /secure/review-bundles/cohort-1 \
  --max-items 100
```

The command opens the database read-only and refuses a non-empty output directory.
It verifies every copied artifact against the stored SHA-256 and byte size. For PDF
candidates it includes the parent official PDF, selected OCR page artifacts, issue
text, candidate source text, and a review template. It also exports each completely
extracted but not yet human-segmented PDF issue with all pages and a `segments.json`
template. An export is complete only when `manifest.json` exists.

The manifest fixes each queue item ID, source checksum, review file path, and a
checksum of that snapshot. Export does not change queue stages or public data.

## Segment A Complete PDF Issue

OCR headings are hints only. Fill the issue's `segments.json` with page ranges and
a corrected transcription copied and checked against the official PDF. Shared
boundary pages are allowed; ranges that overlap by more than that are rejected.
Set `reviewKind` to `ai_assisted` for a machine-assisted draft or to
`human_verified` only when the named responsible reviewer has inspected the
official pages. AI-assisted submissions remain private and cannot satisfy any
ready, cohort, health, or public-release gate.
First validate without writing:

```bash
node collector/src/cli.js --historical-pdf-segment 2 \
  --segments-file /secure/review-bundles/cohort-1/issues/2/segments.json \
  --dry-run
```

Apply the exact checksum-bound submission after review:

```bash
node collector/src/cli.js --historical-pdf-segment 2 \
  --segments-file /secure/review-bundles/cohort-1/issues/2/segments.json
```

The source PDF and complete extraction must still match the exported SHA-256 and
byte sizes. Applying creates only private `manual_review` candidate rows and an
immutable segmentation submission. Only `human_verified` provenance can later
support a structured policy review. A corrected later submission creates distinct
candidates and quarantines the earlier ones without deleting their audit history.

## Review And Apply

Compare the candidate text and every quoted claim with the included official PDF
pages. Complete the lifecycle, implementation, outcome, ambiguity, evidence quote,
review note, reviewer, and review time fields. Plans, meetings, and intended funding
must not be recorded as completed implementation or results.

Validate before applying:

```bash
node collector/src/cli.js --historical-review 123 \
  --review-file /secure/review-bundles/cohort-1/items/123/review.json \
  --dry-run
```

Apply only after validation succeeds:

```bash
node collector/src/cli.js --historical-review 123 \
  --review-file /secure/review-bundles/cohort-1/items/123/review.json
```

Applying stores the complete normalized review, source checksum, reviewer identity,
review time, and linked assessment in `historical_review_submissions`. The submission
is immutable. Ready, cohort, and public release guards reject a missing or mismatched
review submission. Schema 14 also rejects every PDF candidate whose current content
checksum is not linked to an immutable `human_verified` segmentation submission for
its parent issue.
