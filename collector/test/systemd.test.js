'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const systemdDir = path.join(__dirname, '../systemd');
const deployScript = path.join(__dirname, '../../deploy/deploy-release.sh');

test('historical analysis is not blocked behind the PDF OCR queue', () => {
  const service = fs.readFileSync(path.join(systemdDir, 'policy-monitor-historical.service'), 'utf8');
  assert.doesNotMatch(service, /--historical-pdf-process/);
  assert.match(service, /--historical-process/);
  assert.match(service, /--historical-verify/);
  assert.match(service, /--historical-evidence/);
  assert.match(service, /--historical-analyze/);
  assert.doesNotMatch(service, /--historical-framework/);
  assert.match(service, /--historical-release/);
  assert.match(service, /^SuccessExitStatus=2$/m);
});

test('historical PDF OCR drains independently and remains load bounded', () => {
  const service = fs.readFileSync(path.join(systemdDir, 'policy-monitor-historical-ocr.service'), 'utf8');
  const timer = fs.readFileSync(path.join(systemdDir, 'policy-monitor-historical-ocr.timer'), 'utf8');
  assert.match(service, /--historical-pdf-process --adaptive-load/);
  assert.match(service, /--ocr-page-concurrency 1/);
  assert.match(service, /^SuccessExitStatus=2$/m);
  assert.match(service, /^MemoryMax=512M$/m);
  assert.match(service, /^CPUQuota=150%$/m);
  assert.match(timer, /^OnUnitInactiveSec=2min$/m);
  assert.match(timer, /^Unit=policy-monitor-historical-ocr\.service$/m);
});

test('production deployment manages the independent historical OCR timer', () => {
  const script = fs.readFileSync(deployScript, 'utf8');
  assert.match(script, /policy-monitor-historical-ocr\.service/);
  assert.match(script, /policy-monitor-historical-ocr\.timer/);
  assert.match(script, /systemctl enable[\s\S]*policy-monitor-historical-ocr\.timer/);
  assert.match(script, /systemctl start[\s\S]*policy-monitor-historical-ocr\.timer/);
});

test('historical model framework drains independently with bounded requests', () => {
  const service = fs.readFileSync(
    path.join(systemdDir, 'policy-monitor-historical-framework.service'),
    'utf8'
  );
  const timer = fs.readFileSync(
    path.join(systemdDir, 'policy-monitor-historical-framework.timer'),
    'utf8'
  );
  assert.match(service, /--historical-framework --analysis auto --adaptive-load/);
  assert.match(service, /--model-concurrency 2/);
  assert.match(service, /--model-timeout-ms 240000/);
  assert.match(service, /^TimeoutStartSec=50min$/m);
  assert.match(service, /^SuccessExitStatus=2$/m);
  assert.match(timer, /^OnUnitInactiveSec=2min$/m);
  assert.match(timer, /^Unit=policy-monitor-historical-framework\.service$/m);
});

test('production deployment manages the independent historical model timer', () => {
  const script = fs.readFileSync(deployScript, 'utf8');
  assert.match(script, /policy-monitor-historical-framework\.service/);
  assert.match(script, /systemctl enable[\s\S]*policy-monitor-historical-framework\.timer/);
  assert.match(script, /systemctl start[\s\S]*policy-monitor-historical-framework\.timer/);
});
