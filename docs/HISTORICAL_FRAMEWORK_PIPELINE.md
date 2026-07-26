# Historical Structured-Framework Queue

The framework worker converts a release-eligible four-status assessment into the
reader-facing explanation used by the policy detail page. It runs before cohort
validation and never publishes directly.

## Required fields

Every item must contain all four sections:

1. The concrete policy problem.
2. At least one policy tool and its transmission mechanism.
3. At least one affected group with conditions and boundaries.
4. At least one execution step from formal text toward implementation or results.

Each section and each array entry must include a verbatim quote from a supplied,
checksum-valid official source. The worker resolves model `source_id` values against
the private evidence bundle and verifies every quote against that source text.
Unknown sources, fabricated quotes, or missing section citations make
`framework.ready` false and keep the item private with an exponential retry time.

Historical comparisons are optional when no verified predecessor or successor is
available. A comparison is retained only when the same row cites both the current
policy and a verified related historical policy. Implementation or result reports
cannot be presented as predecessor policies.

## Immutability and release

Every model response is stored as an immutable row in
`historical_analysis_frameworks`, including the source checksum, evidence-bundle
fingerprint, response checksum, model, prompt version, normalized framework, and
accepted citations. A later successful retry inserts a new version rather than
rewriting the earlier incomplete output.

An item reaches private `ready` only after this framework is complete. Database
triggers, cohort regression, the release worker, and the public release mapping all
revalidate the framework. The public analysis receives the exact same framework
JSON; it cannot be replaced between private approval and publication.

```bash
node collector/src/cli.js --historical-framework --analysis auto \
  --adaptive-load --min-items 5 --max-items 100
```

`auto` processes items only when the model endpoint is configured. Without model
configuration, items remain private. Rules mode cannot satisfy this gate.
