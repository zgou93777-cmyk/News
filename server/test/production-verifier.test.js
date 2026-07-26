'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  OCR_COMMANDS,
  verifyDatabase,
  tesseractLanguages
} = require('../../deploy/verify-production');
const { openDatabase } = require('../src/db');

test('production verifier checks schema, SQLite integrity and historical mappings', () => {
  const db = openDatabase(':memory:');
  try {
    const report = verifyDatabase(db);
    assert.equal(report.ok, true);
    assert.ok(report.checks.every((check) => check.ok));
  } finally {
    db.close();
  }
});

test('OCR language parser requires exact language identifiers', () => {
  const languages = tesseractLanguages('List of available languages (2):\nchi_sim\neng\n');
  assert.equal(languages.has('chi_sim'), true);
  assert.equal(languages.has('eng'), true);
  assert.equal(languages.has('chi'), false);
});

test('production OCR checks use the version flags supported by each tool', () => {
  assert.deepEqual(OCR_COMMANDS, [
    ['pdftotext', ['-v']],
    ['pdfinfo', ['-v']],
    ['pdftoppm', ['-v']],
    ['tesseract', ['--version']]
  ]);
});

test('deployment migrates the configured production database', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../deploy/deploy-release.sh'), 'utf8');
  assert.match(
    script,
    /DB_PATH="\$DB_PATH" "\$NODE_BIN" --disable-warning=ExperimentalWarning scripts\/init-db\.js/
  );
});
