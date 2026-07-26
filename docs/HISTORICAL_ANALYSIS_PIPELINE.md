# Historical Four-Status Analysis

The historical analysis worker runs only after source metadata, lifecycle,
implementation, and outcome evidence processing has reached a final private state.
It never creates a public article.

## Classification

- `verified`: both implementation evidence and result-oriented official evidence
  pass the evidence gates.
- `partial`: implementation or outcome evidence passes, but not both.
- `watching`: a complete official search scope found neither implementation nor
  outcome evidence. This does not assert that implementation never happened.
- `ambiguous`: critical official values conflict or the policy cycle is internally
  inconsistent. Automatic release is blocked pending human review.

Observed results do not prove policy causation. Meetings, plans, intended funding,
and policy releases remain excluded evidence and cannot raise a classification.

## Release gates

Each assessment records the result and reason for all of these checks:

1. Private lifecycle-verification stage.
2. Official source URL and matching source-text checksum.
3. Verified source and metadata state.
4. Verbatim official evidence for the title, issuer, publication date, and document
   number when one exists.
5. Closed effective/repeal lifecycle search.
6. Complete, current implementation evidence search.
7. Complete, current outcome evidence search.
8. No critical evidence conflicts.
9. Minimum evidence confidence of `0.95`.

Passing an assessment changes the private queue item to `ready`. Failing an
assessment leaves it private and records the failed gate names. Every distinct
input fingerprint creates an immutable row in `historical_analysis_versions`.

```bash
node collector/src/cli.js --historical-analyze \
  --adaptive-load --min-items 5 --max-items 100
```
