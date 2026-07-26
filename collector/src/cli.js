#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { loadConfig } = require('../../server/src/config');
const { openDatabase } = require('../../server/src/db');
const { runCoverBackfill } = require('./cover-backfill');
const {
  historicalQueueAudit,
  historicalQueueStats,
  runHistoricalDiscovery,
  runHistoricalQueue
} = require('./historical-backfill');
const { runHistoricalReview } = require('./historical-review');
const { runHistoricalPdfQueue } = require('./historical-pdf');
const { runHistoricalVerificationQueue } = require('./historical-verification');
const { runHistoricalEvidenceQueue } = require('./historical-evidence');
const { runHistoricalAnalysisQueue } = require('./historical-analysis');
const { runHistoricalReleaseQueue } = require('./historical-release');
const { approveHistoricalCohort, auditHistoricalCohort } = require('./historical-cohort');
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
  ['--family-slug', 'familySlug'], ['--family-title', 'familyTitle'],
  ['--historical-source', 'historicalSource'], ['--historical-sources-file', 'historicalSourcesFile'],
  ['--from-year', 'fromYear'], ['--to-year', 'toYear'], ['--delay-ms', 'delayMs'], ['--min-items', 'minItems'],
  ['--historical-review', 'historicalReview'], ['--review-file', 'reviewFile'],
  ['--historical-cache-dir', 'cacheDir'], ['--ocr-page-budget', 'ocrPageBudget'],
  ['--ocr-languages', 'ocrLanguages'], ['--ocr-dpi', 'ocrDpi'],
  ['--ocr-psm', 'ocrPsm'], ['--ocr-oem', 'ocrOem'], ['--ocr-page-concurrency', 'ocrPageConcurrency'],
  ['--historical-cohort-approve', 'historicalCohortApprove'],
  ['--approved-by', 'approvedBy'], ['--approval-note', 'approvalNote']
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
  node src/cli.js --historical-discover [--from-year 1949] [--to-year YYYY] [--max-items 100]
  node src/cli.js --historical-process [--adaptive-load] [--min-items 5] [--max-items 100]
  node src/cli.js --historical-pdf-process [--adaptive-load] [--max-items 5] [--ocr-page-budget 20]
    [--ocr-languages chi_sim+chi_tra+eng] [--ocr-dpi 300] [--ocr-psm 3] [--ocr-oem 1]
    [--ocr-page-concurrency 2]
  node src/cli.js --historical-verify [--adaptive-load] [--max-items 100]
  node src/cli.js --historical-evidence [--adaptive-load] [--max-items 100]
  node src/cli.js --historical-analyze [--adaptive-load] [--max-items 100]
  node src/cli.js --historical-cohort-audit [--max-items 100]
  node src/cli.js --historical-cohort-approve <cohort-id> --approved-by <id> --approval-note <text>
  node src/cli.js --historical-release [--adaptive-load] [--max-items 100]
  node src/cli.js --historical-status
  node src/cli.js --historical-audit
  node src/cli.js --historical-review <queue-id> --review-file <review.json> [--dry-run]

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
  --historical-discover    Discover official archive entries into the private review queue
  --historical-process     Slowly fetch/extract queued entries; never publishes them
  --historical-pdf-process Cache, extract/OCR and segment private PDF issue rows
  --historical-verify      Verify private source metadata and official lifecycle evidence
  --historical-evidence    Find implementation, paid funding and outcome evidence
  --historical-analyze     Apply auditable four-status analysis and release gates
  --historical-cohort-audit Validate the first complete private cohort without publishing
  --historical-cohort-approve ID  Explicitly approve a validated cohort for limited release
  --historical-release     Publish only ready items that pass database release guards
  --adaptive-load          Recheck CPU and memory pressure between historical items
  --historical-status      Show private queue counts by stage
  --historical-audit       Audit recovery boundaries, integrity and current capacity
  --historical-review ID   Validate a structured human review; moves only to private ready state
  --review-file PATH       Review evidence, policy cycle, implementation, outcome and analysis JSON
  --approved-by ID         Responsible reviewer for cohort approval
  --approval-note TEXT     Approval scope and regression decision for the cohort
  --from-year YYYY         Historical discovery lower bound; minimum 1949
  --to-year YYYY           Historical discovery upper bound
  --delay-ms N             Delay between historical queue items; default 1500
  --min-items N            Minimum adaptive batch size; default 5
  --ocr-page-budget N      Maximum newly OCRed pages per PDF and run; default 20
  --ocr-languages IDS      Plus-separated Tesseract languages; default chi_sim+chi_tra+eng
  --ocr-dpi N              Scan rendering resolution from 150 to 600; default 300
  --ocr-psm N              Tesseract page segmentation mode from 0 to 13; default 3
  --ocr-oem N              Tesseract engine mode from 0 to 3; default 1
  --ocr-page-concurrency N Concurrent OCR pages from 1 to 2; default 1
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
    else if (argument === '--historical-discover') options.historicalDiscover = true;
    else if (argument === '--historical-process') options.historicalProcess = true;
    else if (argument === '--historical-pdf-process') options.historicalPdfProcess = true;
    else if (argument === '--historical-verify') options.historicalVerify = true;
    else if (argument === '--historical-evidence') options.historicalEvidence = true;
    else if (argument === '--historical-analyze') options.historicalAnalyze = true;
    else if (argument === '--historical-cohort-audit') options.historicalCohortAudit = true;
    else if (argument === '--historical-release') options.historicalRelease = true;
    else if (argument === '--historical-status') options.historicalStatus = true;
    else if (argument === '--historical-audit') options.historicalAudit = true;
    else if (argument === '--adaptive-load') options.adaptiveLoad = true;
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
  if (options.minItems !== undefined) {
    options.minItems = Number(options.minItems);
    if (!Number.isSafeInteger(options.minItems) || options.minItems < 1 || options.minItems > 100) {
      throw new Error('--min-items must be an integer from 1 to 100');
    }
    if (options.maxItems && options.minItems > options.maxItems) {
      throw new Error('--min-items cannot exceed --max-items');
    }
  }
  const currentYear = new Date().getFullYear();
  for (const key of ['fromYear', 'toYear']) {
    if (options[key] === undefined) continue;
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < 1949 || options[key] > currentYear + 1) {
      throw new Error(`--${key === 'fromYear' ? 'from-year' : 'to-year'} must be between 1949 and ${currentYear + 1}`);
    }
  }
  if (options.fromYear && options.toYear && options.fromYear > options.toYear) {
    throw new Error('--from-year cannot be later than --to-year');
  }
  if (options.delayMs !== undefined) {
    options.delayMs = Number(options.delayMs);
    if (!Number.isSafeInteger(options.delayMs) || options.delayMs < 0 || options.delayMs > 60_000) {
      throw new Error('--delay-ms must be an integer from 0 to 60000');
    }
  }
  if (options.ocrPageBudget !== undefined) {
    options.ocrPageBudget = Number(options.ocrPageBudget);
    if (!Number.isSafeInteger(options.ocrPageBudget) || options.ocrPageBudget < 1 || options.ocrPageBudget > 200) {
      throw new Error('--ocr-page-budget must be an integer from 1 to 200');
    }
    if (!options.historicalPdfProcess) {
      throw new Error('--ocr-page-budget is only valid with --historical-pdf-process');
    }
  }
  const ocrIntegers = [
    ['ocrDpi', '--ocr-dpi', 150, 600],
    ['ocrPsm', '--ocr-psm', 0, 13],
    ['ocrOem', '--ocr-oem', 0, 3],
    ['ocrPageConcurrency', '--ocr-page-concurrency', 1, 2]
  ];
  for (const [key, flag, minimum, maximum] of ocrIntegers) {
    if (options[key] === undefined) continue;
    options[key] = Number(options[key]);
    if (!Number.isSafeInteger(options[key]) || options[key] < minimum || options[key] > maximum) {
      throw new Error(`${flag} must be an integer from ${minimum} to ${maximum}`);
    }
    if (!options.historicalPdfProcess) throw new Error(`${flag} is only valid with --historical-pdf-process`);
  }
  if (options.ocrLanguages !== undefined) {
    if (!/^[a-z0-9_]+(?:\+[a-z0-9_]+)*$/i.test(options.ocrLanguages)) {
      throw new Error('--ocr-languages must contain plus-separated Tesseract identifiers');
    }
    if (!options.historicalPdfProcess) {
      throw new Error('--ocr-languages is only valid with --historical-pdf-process');
    }
  }
  if (options.adaptiveLoad && !options.historicalProcess && !options.historicalPdfProcess
      && !options.historicalVerify && !options.historicalEvidence && !options.historicalAnalyze
      && !options.historicalRelease) {
    throw new Error('--adaptive-load is only valid with a historical processing mode');
  }
  if (options.minItems !== undefined && !options.historicalProcess && !options.historicalPdfProcess
      && !options.historicalVerify && !options.historicalEvidence && !options.historicalAnalyze
      && !options.historicalRelease) {
    throw new Error('--min-items is only valid with a historical processing mode');
  }
  const modes = [
    Boolean(options.url), Boolean(options.file), Boolean(options.allSources),
    Boolean(options.backfillSeed), Boolean(options.backfillImages),
    Boolean(options.reconcileRelevance), Boolean(options.reconcileLineage),
    Boolean(options.historicalDiscover), Boolean(options.historicalProcess), Boolean(options.historicalPdfProcess),
    Boolean(options.historicalVerify), Boolean(options.historicalEvidence), Boolean(options.historicalAnalyze),
    Boolean(options.historicalCohortAudit), Boolean(options.historicalCohortApprove),
    Boolean(options.historicalRelease), Boolean(options.historicalStatus),
    Boolean(options.historicalAudit),
    Boolean(options.historicalReview)
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
  if (options.historicalCohortApprove && (!options.approvedBy || !options.approvalNote)) {
    throw new Error('--historical-cohort-approve requires --approved-by and --approval-note');
  }
  if ((options.approvedBy || options.approvalNote) && !options.historicalCohortApprove) {
    throw new Error('--approved-by and --approval-note are only valid with --historical-cohort-approve');
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
  options.cacheDir = path.resolve(options.cacheDir || serverConfig.historicalCacheDir);
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
      : options.historicalDiscover
        ? await runHistoricalDiscovery(db, { ...options, notify: false })
      : options.historicalProcess
        ? await runHistoricalQueue(db, { ...options, notify: false })
      : options.historicalPdfProcess
        ? await runHistoricalPdfQueue(db, { ...options, notify: false })
      : options.historicalVerify
        ? await runHistoricalVerificationQueue(db, { ...options, notify: false })
      : options.historicalEvidence
        ? await runHistoricalEvidenceQueue(db, { ...options, notify: false })
      : options.historicalAnalyze
        ? await runHistoricalAnalysisQueue(db, { ...options, notify: false })
      : options.historicalCohortAudit
        ? auditHistoricalCohort(db, options)
      : options.historicalCohortApprove
        ? approveHistoricalCohort(db, options)
      : options.historicalRelease
        ? await runHistoricalReleaseQueue(db, { ...options, notify: false })
      : options.historicalStatus
        ? { status: 'succeeded', queue: historicalQueueStats(db) }
      : options.historicalAudit
        ? historicalQueueAudit(db)
      : options.historicalReview
        ? runHistoricalReview(db, options)
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
