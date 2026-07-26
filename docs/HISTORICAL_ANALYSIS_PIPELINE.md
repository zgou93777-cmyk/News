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
`partial` describes an incomplete public evidence chain; it does not assert that an
unobserved implementation or result did not happen.

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

The automated confidence floor is fixed at `0.95`; runtime options may raise it but
cannot lower it. Every accepted implementation or outcome row must still point to a
currently verified source and metadata record, match that source's publication date,
retain a verbatim quote found in checksum-valid source text, and agree with the
completed search count. `not_applicable` can only be approved by `human-review-v1`.

Methodology `historical-evidence-gates-v2` stores every verified metadata quote and
accepted policy-evidence quote as a structured citation with its official URL,
observed date, confidence, and source state. It also stores both complete search
scopes; quotes are not truncated to a display-only sample.

Passing an assessment changes the private queue item to `ready`. Failing an
assessment leaves it private and records the failed gate names. Every distinct
input fingerprint creates an immutable row in `historical_analysis_versions`.
Manual assessments additionally retain the complete normalized review JSON, source
checksum, reviewer identity, review time, and assessment mapping in the immutable
`historical_review_submissions` table. Database, cohort, and public release guards
all require that mapping to remain exact.

```bash
node collector/src/cli.js --historical-analyze \
  --adaptive-load --min-items 5 --max-items 100
```
