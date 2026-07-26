'use strict';

const { loadConfig } = require('../src/config');
const { getSchemaVersion, openDatabase } = require('../src/db');

const config = loadConfig();
const db = openDatabase(config.dbPath);
try {
  process.stdout.write(`Initialized ${config.dbPath} (schema ${getSchemaVersion(db)})\n`);
} finally {
  db.close();
}
