# Historical Automatic Release

The release worker is the only automatic path from the private historical queue
to public articles. It does not send one notification per historical article.

Before opening a transaction it verifies that the approved assessment fingerprint
still matches the current private corpus. A newer corpus watermark requeues the
item for evidence search and analysis instead of publishing a stale conclusion.

Inside one transaction the worker:

1. Resolves the official source and a policy-specific family.
2. Inserts or strictly links an identical public document.
3. Creates an immutable public analysis version.
4. Copies accepted evidence into public signals and implementation events.
5. Stores excluded meeting/release candidates as non-implementation events.
6. Creates the policy assessment snapshot.
7. Inserts an immutable private-to-public release mapping.
8. Marks the private item `published` and links its public document.

SQLite triggers independently reject a release unless the approved assessment has
confidence of at least `0.95`, contains no failed gate, uses an approved methodology,
and exactly matches the public title, issuer, document number, dates, content,
checksum, analysis version, and release mapping.

```bash
node collector/src/cli.js --historical-release \
  --adaptive-load --min-items 5 --max-items 100
```
