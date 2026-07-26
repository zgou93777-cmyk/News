'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArguments } = require('../src/cli');

test('CLI defaults to scanning all enabled sources', () => {
  const options = parseArguments([]);
  assert.equal(options.allSources, true);
  assert.equal(options.analysisMode, 'auto');
  assert.equal(options.notify, true);
});

test('CLI validates mutually exclusive modes and local attribution', () => {
  assert.throws(() => parseArguments(['--url', 'https://example.gov.cn/a', '--all-sources']), /choose only one/);
  assert.throws(() => parseArguments(['--file', 'policy.txt']), /require --source or --issuer/);
  assert.equal(parseArguments(['--file', 'policy.txt', '--source', 'gov-policy']).sourceId, 'gov-policy');
});

test('relevance reconciliation defaults to dry-run and requires explicit apply', () => {
  const preview = parseArguments(['--reconcile-relevance']);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.apply, undefined);
  const apply = parseArguments(['--reconcile-relevance', '--apply']);
  assert.equal(apply.apply, true);
  assert.notEqual(apply.dryRun, true);
  assert.throws(() => parseArguments(['--apply']), /only valid/);
  assert.throws(() => parseArguments(['--reconcile-relevance', '--apply', '--dry-run']), /cannot be used together/);
});

test('lineage reconciliation defaults to dry-run and supports explicit apply', () => {
  const preview = parseArguments(['--reconcile-lineage']);
  assert.equal(preview.reconcileLineage, true);
  assert.equal(preview.dryRun, true);
  const apply = parseArguments(['--reconcile-lineage', '--apply']);
  assert.equal(apply.apply, true);
  assert.notEqual(apply.dryRun, true);
  assert.throws(
    () => parseArguments(['--reconcile-lineage', '--reconcile-relevance']),
    /choose only one/
  );
});

test('cover backfill defaults to dry-run and requires explicit apply to write', () => {
  const preview = parseArguments(['--backfill-images']);
  assert.equal(preview.backfillImages, true);
  assert.equal(preview.dryRun, true);
  const apply = parseArguments(['--backfill-images', '--apply', '--max-items', '25']);
  assert.equal(apply.apply, true);
  assert.equal(apply.maxItems, 25);
  assert.notEqual(apply.dryRun, true);
  assert.throws(
    () => parseArguments(['--backfill-images', '--reconcile-lineage']),
    /choose only one/
  );
  assert.equal(parseArguments(['--backfill-covers']).backfillImages, true);
});
