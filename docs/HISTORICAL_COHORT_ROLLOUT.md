# Historical First-Cohort Rollout

Historical release is controlled by a Schema 13 singleton state. Its default mode
is `disabled`; a `ready` assessment is therefore necessary but never sufficient to
publish an article.

## Build and regression

The hourly worker runs:

```bash
node collector/src/cli.js --historical-cohort-audit --max-items 100
```

Until exactly 100 private `ready` policies exist, it reports
`waiting_for_eligible_items` and writes no cohort. Once 100 are available, it locks
each item to its immutable assessment version and rechecks:

- approved methodology, four-status value, all release gates, and confidence >= 0.95;
- an immutable normalized review submission for every `human-review-v1` assessment;
- an immutable human page-segmentation submission for every PDF-derived policy;
- current official source URL and source-text checksum;
- every structured citation and verbatim quote;
- both complete corpus search scopes for automated assessments;
- no existing public document;
- total regression duration, RSS growth, normalized server load, and free memory.

The manifest stores item IDs, assessment IDs, input checksums, individual check
results, aggregate status counts, load snapshots, duration, memory growth, and one
SHA-256 checksum. Cohort membership is immutable.

## Explicit approval

A successful regression creates a `validated` cohort but keeps release disabled.
Approval requires a responsible identity and decision note:

```bash
node collector/src/cli.js --historical-cohort-approve <cohort-id> \
  --approved-by <reviewer-id> \
  --approval-note <review-decision>
```

Approval recomputes every current assessment and the manifest checksum before the
database changes mode to `cohort`. The release worker may then publish only those
100 item/assessment pairs. After the last pair is released, the database immediately
returns to `disabled` and marks the cohort `observing`. All later `ready` rows remain
private.

`full` mode exists in the database transition model but has no automatic command in
this phase. It can be opened only after the observed cohort is complete and the next
rollout step explicitly adds and tests that operation.
