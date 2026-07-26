#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { loadConfig } = require('../../server/src/config');
const { openDatabase } = require('../../server/src/db');
const { runCoverBackfill } = require('./cover-backfill');
const { runCollection, runSeedBackfill } = require('./pipeline');
const { runReconcileLineage } = require('./reconcile-lineage');
const { runReconcileRelevance } = require('./reconcile');

const VALUE_OPTIONS = new Map([
  ['--url', 'url'], ['--file', 'file'], ['--source', 'sourceId'],
  ['--sources-file', 'sourcesFile'], ['--title', 'title'], ['--issuer', 'issuer'],
  ['--published-at', 'publishedAt'], ['--category', 'category'],
  ['--original-url', 'originalUrl'], ['--content-type', 'contentType'],
  ['--analysis', 'analysisMode'], ['--max-items', 'maxItems'],
  ['--public-base-url', 'publicBaseUrl'], ['--db-path', 'dbPath'],
  ['--family-slug', 'familySlug'], ['--family-title', 'familyTitle']
]);

const HELP = `Usage:
  node src/cli.js --url <official-url> [--source <id>] [options]
  node src/cli.js --file <text-or-html> --source <id> [options]
  node src/cli.js --source <id> [--max-items 10] [options]
  node src/cli.js --all-sources [--max-items 10] [options]
  node src/cli.js --backfill-seed [options]
  node src/cli.js --backfill-images [--dry-run|--apply] [--max-items 100]
  node src/cli.js --reconcile-relevance [--dry-run|--apply]
  node src/cli.js --reconcile-lineage [--dry-run|--apply]

Options:
  --dry-run                 Fetch and analyze without persistent writes or notifications
  --apply                   Apply the selected reconciliation or cover backfill operation
  --no-notify               Store content without DingTalk or Web Push
  --analysis auto|rules|model  Default: auto; auto falls back to rules-based
  --published-at YYYY-MM-DD Required when no publication date can be extracted
  --original-url URL        Canonical official URL for local input
  --family-slug SLUG        Attach to an explicit policy family
  --family-title TITLE      Required only when creating a new family
  --db-path PATH            Override DB_PATH
  --public-base-url URL     Override PUBLIC_BASE_URL for notification links
`;

function parseArguments(argv) {
  const options = { analysisMode: 'auto', notify: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--no-notify') options.notify = false;
    else if (argument === '--all-sources') options.allSources = true;
    else if (argument === '--backfill-seed') options.backfillSeed = true;
    else if (argument === '--backfill-images' || argument === '--backfill-covers') options.backfillImages = true;
    else if (argument === '--reconcile-relevance') options.reconcileRelevance = true;
    else if (argument === '--reconcile-lineage') options.reconcileLineage = true;
    else if (argument === '--apply') options.apply = true;
    else if (VALUE_OPTIONS.has(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      options[VALUE_OPTIONS.get(argument)] = value;
      index += 1;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  if (!['auto', 'rules', 'model'].includes(options.analysisMode)) {
    throw new Error('--analysis must be auto, rules or model');
  }
  if (options.maxItems !== undefined) {
    options.maxItems = Number(options.maxItems);
    if (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1 || options.maxItems > 100) {
      throw new Error('--max-items must be an integer from 1 to 100');
    }
  }
  const modes = [
    Boolean(options.url), Boolean(options.file), Boolean(options.allSources),
    Boolean(options.backfillSeed), Boolean(options.backfillImages),
    Boolean(options.reconcileRelevance), Boolean(options.reconcileLineage)
  ].filter(Boolean).length;
  if (modes > 1) {
    throw new Error('choose only one collection, backfill, or reconciliation mode');
  }
  if (options.apply && !options.backfillImages && !options.reconcileRelevance && !options.reconcileLineage) {
    throw new Error('--apply is only valid with --backfill-images, --reconcile-relevance or --reconcile-lineage');
  }
  if (options.apply && options.dryRun) throw new Error('--apply and --dry-run cannot be used together');
  if (options.reconcileRelevance && !options.apply) options.dryRun = true;
  if (options.reconcileLineage && !options.apply) options.dryRun = true;
  if (options.backfillImages && !options.apply) options.dryRun = true;
  if (options.file && !options.sourceId && !options.issuer) {
    throw new Error('local files require --source or --issuer');
  }
  if (options.familySlug && !options.familyTitle) {
    // Existing families do not need a title; persistence validates only if creation is required.
  }
  if (!modes && !options.sourceId && !options.help) options.allSources = true;
  return options;
}

function openDryRunDatabase(dbPath) {
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: true });
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    return db;
  }
  return openDatabase(':memory:');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const serverConfig = loadConfig();
  const dbPath = path.resolve(options.dbPath || serverConfig.dbPath);
  options.notificationConfig = serverConfig;
  options.frontendDir = serverConfig.frontendDir;
  options.publicBaseUrl = options.publicBaseUrl || process.env.PUBLIC_BASE_URL || '';

  // Seed dry-runs use an isolated database because the seed operation is intentionally idempotent but write-based.
  const db = options.dryRun && options.backfillSeed
    ? openDatabase(':memory:')
    : options.dryRun ? openDryRunDatabase(dbPath) : openDatabase(dbPath);
  try {
    const result = options.backfillSeed
      ? await runSeedBackfill(db, options)
      : options.backfillImages
        ? await runCoverBackfill(db, options)
      : options.reconcileRelevance
        ? runReconcileRelevance(db, options)
        : options.reconcileLineage
          ? runReconcileLineage(db, options)
          : await runCollection(db, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'failed') process.exitCode = 1;
    else if (result.status === 'partial') process.exitCode = 2;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Collector failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { HELP, main, openDryRunDatabase, parseArguments };
