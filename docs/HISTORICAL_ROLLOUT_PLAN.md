# Historical Rollout Plan

The phases below run continuously in order; they are not calendar gates. A feature
may already exist in source, but a phase is complete only after focused tests, a
production audit, and a GitHub push. Work starts on the next phase immediately after
that push. Historical rows remain private until every later release gate passes.

| Step | Acceptance scope | Status |
| --- | --- | --- |
| 1 | Queue, state machine, server load, and checkpoint recovery audit | Complete |
| 2 | PDF cache, Chinese OCR, article segmentation, and failure retry | Complete |
| 3 | Issuer, document number, publication/effective/repeal dates, and replacement relations | Complete |
| 4 | Implementation, paid funding, outcome evidence, and complete-corpus `not_found` | Complete |
| 5 | Four statuses, confidence threshold, quote retention, and automatic release guards | Complete |
| 6 | First 100-row regression, load test, and production deployment | In progress |
| 7 | Observe the first release cohort, then explicitly open the full historical queue | Pending |

## Release rules

- Each phase receives its own commit and is pushed to `main` after verification.
- A phase does not borrow acceptance from a later phase, even when the code paths
  share tables or workers.
- Discovery, OCR, verification, analysis, and evidence search do not publish.
- The full queue is not opened merely because a timer is healthy; the first 100
  release-eligible rows must pass the regression and observation gate.
- Schema 13 keeps release mode `disabled` until a complete 100-row manifest passes
  evidence and load regression and receives an explicit recorded approval.
- Production failures retain the database and application backup for that release
  and must be resolved in a new GitHub commit before deployment is retried.
