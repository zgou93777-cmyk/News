# Historical Automatic Release

The release worker is the only automatic path from the private historical queue
to public articles. It does not send one notification per historical article.

Inside a write-locked transaction it verifies that the approved assessment fingerprint
still matches the current private corpus and that the queue analysis JSON exactly
matches the immutable assessment version. A newer corpus watermark, rejected evidence
source, changed source checksum, or altered analysis requeues the item for evidence
search and analysis instead of publishing a stale conclusion.

Inside one transaction the worker:

1. Resolves the official source and a policy-specific family.
2. Inserts or strictly links an identical public document.
3. Creates an immutable public analysis version.
4. Copies accepted evidence into public signals and implementation events.
5. Stores excluded meeting/release candidates as non-implementation events.
6. Creates the policy assessment snapshot.
7. Inserts an immutable private-to-public release mapping.
8. Marks the private item `published` and links its public document.

Schema 9 SQLite triggers independently reject a release unless the approved assessment
has confidence of at least `0.95`, contains no failed gate, uses
`historical-evidence-gates-v2` or `human-review-v1`, and exactly matches the queue
analysis plus the public title, issuer, document number, dates, content, checksum,
analysis text, analysis version, and release mapping. Every accepted automated
evidence row must also retain a matching public signal and a currently valid official
source quote.

```bash
node collector/src/cli.js --historical-release \
  --adaptive-load --min-items 5 --max-items 100
```
