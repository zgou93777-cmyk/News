#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const EXPECTED_SCHEMA = '11';
const REQUIRED_TABLES = [
  'historical_backfill_items',
  'historical_artifacts',
  'historical_verification_evidence',
  'historical_policy_evidence',
  'historical_evidence_searches',
  'historical_analysis_versions',
  'historical_release_cohorts',
  'historical_release_cohort_items',
  'historical_release_control',
  'historical_public_releases'
];
const OCR_COMMANDS = [
  ['pdftotext', ['-v']],
  ['pdfinfo', ['-v']],
  ['pdftoppm', ['-v']],
  ['tesseract', ['--version']]
];

function verifyDatabase(db) {
  const checks = [];
  const add = (name, ok, details = '') => checks.push({ name, ok: Boolean(ok), details });
  const quickCheck = db.prepare('PRAGMA quick_check').all().map((row) => Object.values(row)[0]);
  add('sqlite_quick_check', quickCheck.length === 1 && quickCheck[0] === 'ok', quickCheck.join('; '));
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  add('sqlite_foreign_keys', foreignKeys.length === 0, `${foreignKeys.length} violation(s)`);
  const schemaVersion = db.prepare(`
    SELECT value FROM schema_meta WHERE key = 'schema_version'
  `).get()?.value || null;
  add('schema_version', schemaVersion === EXPECTED_SCHEMA, `expected ${EXPECTED_SCHEMA}, found ${schemaVersion}`);
  const tables = new Set(db.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table'
  `).all().map((row) => row.name));
  const missingTables = REQUIRED_TABLES.filter((name) => !tables.has(name));
  add('historical_tables', missingTables.length === 0, missingTables.join(', '));
  if (missingTables.length === 0) {
    const acceptedEvidence = db.prepare(`
      SELECT evidence.source_url, evidence.evidence_quote, evidence.observed_at,
        source.id AS source_id, source.source_status, source.metadata_status,
        source.source_url AS current_source_url, source.published_at,
        source.content_text, source.checksum
      FROM historical_policy_evidence evidence
      LEFT JOIN historical_backfill_items source ON source.id = evidence.source_item_id
      WHERE evidence.classification = 'accepted'
    `).all();
    const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
    const invalidEvidence = acceptedEvidence.filter((row) => {
      const text = String(row.content_text || '');
      const checksumValid = row.checksum && text
        && (row.checksum === digest(text) || row.checksum === digest(text.replace(/\s+/g, '')));
      return !row.source_id || row.source_status !== 'verified' || row.metadata_status !== 'verified'
        || row.current_source_url !== row.source_url || row.published_at !== row.observed_at
        || !text.includes(row.evidence_quote) || !checksumValid;
    });
    add('historical_evidence_sources', invalidEvidence.length === 0,
      `${invalidEvidence.length} invalid accepted evidence source(s)`);
    const rollout = db.prepare(`
      SELECT control.mode, control.active_cohort_id, cohort.status AS cohort_status,
        cohort.target_size,
        (SELECT count(*) FROM historical_release_cohort_items item
          WHERE item.cohort_id = cohort.id) AS cohort_items
      FROM historical_release_control control
      LEFT JOIN historical_release_cohorts cohort ON cohort.id = control.active_cohort_id
      WHERE control.id = 1
    `).get();
    const rolloutValid = rollout && (
      rollout.mode === 'disabled'
      || (rollout.mode === 'cohort' && rollout.cohort_status === 'approved'
        && Number(rollout.cohort_items) === Number(rollout.target_size))
      || (rollout.mode === 'full' && rollout.cohort_status === 'observing'
        && Number(rollout.cohort_items) === Number(rollout.target_size))
    );
    add('historical_release_control', rolloutValid,
      rollout ? `${rollout.mode}; cohort ${rollout.active_cohort_id || 'none'}` : 'missing singleton control');
    const integrity = db.prepare(`
      SELECT
        count(*) FILTER (
          WHERE item.stage IN ('ready', 'published') AND NOT EXISTS (
            SELECT 1 FROM historical_analysis_versions assessment
            WHERE assessment.id = CAST(json_extract(item.analysis_json, '$.assessmentVersionId') AS INTEGER)
              AND assessment.item_id = item.id AND assessment.release_eligible = 1
              AND assessment.confidence >= 0.95
              AND assessment.methodology IN ('historical-evidence-gates-v2', 'human-review-v1')
              AND assessment.version = CAST(json_extract(item.analysis_json, '$.assessmentVersion') AS INTEGER)
              AND assessment.review_status = json_extract(item.analysis_json, '$.reviewStatus')
              AND assessment.confidence = CAST(json_extract(item.analysis_json, '$.confidence') AS REAL)
              AND assessment.methodology = json_extract(item.analysis_json, '$.methodology')
              AND json_extract(item.analysis_json, '$.gates') = assessment.gates_json
              AND json_array_length(assessment.gates_json) > 0
              AND NOT EXISTS (
                SELECT 1 FROM json_each(assessment.gates_json) gate
                WHERE json_extract(gate.value, '$.passed') IS NOT 1
              )
          )
        ) AS assessment_violations,
        count(*) FILTER (
          WHERE item.stage = 'published' AND NOT EXISTS (
            SELECT 1 FROM historical_public_releases release
            WHERE release.item_id = item.id AND release.document_id = item.document_id
          )
        ) AS release_violations
      FROM historical_backfill_items item
    `).get();
    add('historical_assessments', Number(integrity.assessment_violations) === 0,
      `${integrity.assessment_violations} violation(s)`);
    add('historical_releases', Number(integrity.release_violations) === 0,
      `${integrity.release_violations} violation(s)`);
  }
  return { ok: checks.every((check) => check.ok), checks };
}

function commandCheck(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return {
    name: `command_${command}`,
    ok: !result.error && result.status === 0,
    details: result.error?.message || String(result.stdout || result.stderr || '').split(/\r?\n/)[0]
  };
}

function tesseractLanguages(output) {
  return new Set(String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

function verifyOcrTools() {
  const checks = OCR_COMMANDS.map(([command, args]) => commandCheck(command, args));
  const languages = spawnSync('tesseract', ['--list-langs'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true
  });
  const installed = tesseractLanguages(`${languages.stdout || ''}\n${languages.stderr || ''}`);
  checks.push({
    name: 'tesseract_languages',
    ok: languages.status === 0 && installed.has('chi_sim') && installed.has('chi_tra') && installed.has('eng'),
    details: `required chi_sim, chi_tra, eng; found ${[...installed].sort().join(', ')}`
  });
  return checks;
}

function parseArguments(argv) {
  const result = { dbPath: process.env.DB_PATH || '/var/lib/policy-monitor/policy-monitor.db', checkOcr: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check-ocr') result.checkOcr = true;
    else if (argv[index] === '--db-path') {
      if (!argv[index + 1]) throw new Error('--db-path requires a value');
      result.dbPath = argv[index + 1];
      index += 1;
    } else throw new Error(`unknown option: ${argv[index]}`);
  }
  return result;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const db = new DatabaseSync(path.resolve(options.dbPath), {
    readOnly: true,
    enableForeignKeyConstraints: true
  });
  let report;
  try {
    report = verifyDatabase(db);
  } finally {
    db.close();
  }
  if (options.checkOcr) {
    report.checks.push(...verifyOcrTools());
    report.ok = report.checks.every((check) => check.ok);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Production verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXPECTED_SCHEMA,
  OCR_COMMANDS,
  parseArguments,
  tesseractLanguages,
  verifyDatabase,
  verifyOcrTools
};
