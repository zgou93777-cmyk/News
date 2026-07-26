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
candidates it includes the parent official PDF, only the selected OCR page artifacts,
the issue text and segmentation artifact, the candidate source text, and a review
template. An export is complete only when `manifest.json` exists.

The manifest fixes each queue item ID, source checksum, review file path, and a
checksum of that snapshot. Export does not change queue stages or public data.

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
submission.
