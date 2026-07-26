# Historical Automation Audit

Audited: 2026-07-26

## Public safety boundary

Historical discovery and extraction write only to `historical_backfill_items`.
Public `documents` rows are not created by the discovery or queue workers. Database
triggers reject `ready` and `published` transitions unless source, metadata,
lifecycle, implementation, outcome, analysis, evidence URLs, quotes, and reviewer
fields satisfy the release contract.

## Recovery boundaries

| Stage | Current owner | Recovery behavior |
| --- | --- | --- |
| `discovered` | automatic queue | Process immediately in source-year order. |
| `failed` | automatic queue | Retry after exponential backoff, capped at seven days. |
| `indexed` | archive expansion | Container is complete; child rows carry remaining work. |
| `manual_review` | PDF automation gap | Await cached PDF extraction, OCR, and article segmentation. |
| `needs_review` | verification automation gap | Await metadata, lifecycle, implementation, outcome, and analysis checks. |
| `source_verified` | verification pipeline | Continue with lifecycle verification. |
| `lifecycle_verified` | verification pipeline | Continue with implementation and outcome evidence. |
| `ready` | release worker | Eligible for publication only after every database guard passes. |
| `published` | public archive | Must reference exactly one public document. |

No worker may infer missing evidence. A completed official-source search with no
qualifying result is recorded as `not_found`; an incomplete search remains pending.

## Resource envelope

The production worker is a one-shot systemd service with a 512 MB memory limit and
a 150% CPU quota so OCR cannot consume both cores indefinitely.
Each hourly run selects at most 100 rows. The adaptive controller reduces a batch
to 50, 25, or 5 rows as normalized CPU load rises or free memory falls. Remote HTML
requests retain a five-second interval. Local cached PDF stages do not consume the
remote-request delay budget.

## Operational audit

Run the read-only audit against the configured database:

```bash
node collector/src/cli.js --historical-audit
```

The report separates immediately processable rows, scheduled retries, PDF OCR
backlog, verification backlog, indexed containers, ready rows, and published rows.
It also reports missing years or metadata, release-guard violations, broken parent
links, common failure messages, and the load-adjusted batch recommendation.

## Production acceptance on 2026-07-26

Release `5dc8540` was audited on the production host after the schema 8 deployment.
The first hourly historical unit started at 13:41 CST and exited successfully. Its
observable results were:

- 400 private queue rows, all at `manual_review`, covering 17 represented years
  from 1954 through 1983. Discovery remains incomplete and continues in bounded
  hourly windows.
- No failed rows, scheduled failure retries, missing source years, broken parent
  links, stale ready assessments, release-guard violations, public release
  violations, or public document mismatches.
- Three immutable source PDF artifacts, 60 page-level OCR artifacts, and three
  durable `OCR checkpoint: 20/N pages` records scheduled for retry. No public
  document was created from an incomplete checkpoint.
- An idle load average of 0.00 with 1,368 MiB available memory and 28 GiB available
  disk. The audit recommended 100 non-OCR rows while idle. During OCR the normalized
  load reached 1.015 and the controller reduced the recommendation to the minimum
  batch of 5.
- The API service and both timers remained active. The historical one-shot unit
  reported `Result=success` and `ExecMainStatus=0`; its persistent timer scheduled
  the next bounded run automatically.

This accepts the queue, state machine, resource envelope, and durable checkpoint
mechanism for the July 26 milestone. It does not accept PDF segmentation or release
quality; those remain gated by the later rollout milestones.

## PDF implementation contract

The PDF worker caches immutable source bytes by checksum, preserves page-level text
provenance, prefers embedded text, uses Chinese OCR only when required, splits an
issue into deterministic document candidates, and resumes after every durable
stage. It may create private document candidates but may not mark them `ready` or
publish them. The verification workers remain responsible for every release field.
