'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { verifyDatabase, tesseractLanguages } = require('../../deploy/verify-production');
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
