'use strict';

const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { seedDatabase } = require('../src/seed');

const config = loadConfig();
const db = openDatabase(config.dbPath);
try {
  const result = seedDatabase(db);
  process.stdout.write(`Seed complete: ${JSON.stringify(result)}\n`);
} finally {
  db.close();
}
