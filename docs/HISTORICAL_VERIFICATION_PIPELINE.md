# Historical Metadata and Lifecycle Verification

## Evidence model

Every verified claim is stored in `historical_verification_evidence` with a verbatim
quote, official `.gov.cn` URL, extractor version, confidence, and observed date.
The database rejects a `verified` claim without a value, quote, or source URL. A
`not_found` claim is valid only when it records the exact search scope.

The worker verifies these fields independently:

- Source URL and queued text checksum.
- Title as it appears in the source text.
- Issuing authority from a title, signature line, or formal document-number prefix.
- Document number, including common modern and historical bracket forms.
- Publication date, including Arabic and Chinese-numeral dates.
- Explicit effective date or an explicit publication-date effectiveness clause.
- Explicit expiry, later repeal, or later superseding official document.

Missing core title, issuer, or publication evidence leaves the row at
`needs_review`. A missing document number is recorded as `not_found`; it is never
generated from the title or issue year.

## Lifecycle closure

Later official documents are linked in `historical_policy_relations`. A repeal or
superseding relationship requires the predecessor's exact document number and a
verbatim repeal/replacement sentence in the successor.

Absence of a repeal may be recorded as `not_found` only after all configured
official archive scans covering the policy's later years are complete, all issue
containers are extracted, and the configured archive has no known gap in that
window. Policies crossing the documented 1967-1979 gap remain pending unless an
explicit later official lifecycle document is found.

The worker moves a row through `needs_review`, `source_verified`, and
`lifecycle_verified`. It does not create a public document or mark a row `ready`.

```bash
node collector/src/cli.js --historical-verify \
  --adaptive-load --min-items 5 --max-items 100
```
