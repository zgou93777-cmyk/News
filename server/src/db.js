'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_PATH = path.resolve(__dirname, '..', 'schema.sql');

function openDatabase(filename, { initialize = true } = {}) {
  if (filename !== ':memory:') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  }

  const db = new DatabaseSync(filename, {
    timeout: 5000,
    enableForeignKeyConstraints: true
  });

  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (filename !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  }
  if (initialize) initializeDatabase(db);
  return db;
}

function initializeDatabase(db) {
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

function withTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the original error if the connection already rolled back.
    }
    throw error;
  }
}

function getSchemaVersion(db) {
  return db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()?.value || null;
}

module.exports = { getSchemaVersion, initializeDatabase, openDatabase, withTransaction };
