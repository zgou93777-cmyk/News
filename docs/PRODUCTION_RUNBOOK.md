# Production Runbook

## Build the release archive

Create an archive with the repository contents at its root. Do not include `.git`,
local databases, environment files, caches, or `node_modules`.

```bash
git archive --format=tar.gz --output=policy-monitor.tar.gz HEAD
```

## Deploy

The deployment script tests the staged release before stopping services. It then
backs up the current application plus the SQLite database, WAL, and SHM files;
installs the code without replacing `/opt/policy-monitor` itself; restores readable
application permissions; runs schema migration; verifies SQLite integrity, release
mappings, Poppler, Tesseract, and `chi_sim+eng`; installs systemd units; and performs
a local health check.

```bash
sudo /opt/policy-monitor/deploy/deploy-release.sh /tmp/policy-monitor.tar.gz
```

Backups are stored under `/var/backups/policy-monitor/<UTC timestamp>/`. A failed
deployment restarts the service and timers but does not automatically overwrite the
new code or database; restore from that timestamp after inspecting the failure.

## Verify

```bash
node /opt/policy-monitor/deploy/verify-production.js \
  --db-path /var/lib/policy-monitor/policy-monitor.db --check-ocr
curl --fail https://xw.wyhn.cc/api/health
systemctl list-timers policy-monitor-collector.timer policy-monitor-historical.timer \
  policy-monitor-historical-ocr.timer policy-monitor-historical-framework.timer --all
journalctl -u policy-monitor.service -u policy-monitor-historical.service -u policy-monitor-historical-framework.service --since today --no-pager
```

The hourly historical systemd job runs discovery, extraction, verification, evidence
search, classification, release and a final integrity audit. OCR and citation-checked
model analysis drain through independent load-bounded timers so a slow model response
cannot block collection or verification. A broken assessment, framework, or
private-to-public mapping makes the unit fail and invokes the configured alert service.
