# Historical Implementation and Outcome Evidence

## Strong linkage

A later official document is considered only when its full text contains the target
policy's exact document number or exact title. Fuzzy topic similarity is not enough
to attribute implementation or outcomes to a policy.

Each accepted or excluded candidate is retained in `historical_policy_evidence`.
This makes false-positive controls auditable instead of silently discarding them.

## Accepted evidence

- A formal implementing instrument such as implementation rules, operating rules,
  an application guide, or a task list that explicitly references the target.
- An official sentence recording an action already started, executed, completed,
  built, opened, or put into use.
- Funds, budgets, subsidies, or grants explicitly recorded as already allocated,
  disbursed, paid, or issued. Paid funding is also implementation evidence.
- A result-oriented official report containing observed progress or quantified
  results and explicitly referencing the target policy.

Implementation, funding, and outcome remain separate evidence types. Observed
outcomes do not by themselves prove that the policy caused those outcomes.

## Excluded evidence

- Meetings, briefings, press conferences, speeches, and statements.
- Plans, intended funding, research, targets, requirements, and deployments without
  a completed action.
- A policy release that cites the target but contains no implementation action.
- Historical figures quoted inside another policy document whose title and purpose
  are not result reporting.

Excluded candidates remain stored with the reason for exclusion.

## `not_found` boundary

`not_found` is written only when the configured official archive scan and extraction
window is complete and every matching candidate has a usable publication date. The
exact corpus watermark, candidates checked, accepted matches, and search scope are
stored in `historical_evidence_searches`. Otherwise the status remains `pending`.

The worker updates only private queue evidence fields:

```bash
node collector/src/cli.js --historical-evidence \
  --adaptive-load --min-items 5 --max-items 100
```

It does not mark an item `ready`, create a public document, or send notifications.
