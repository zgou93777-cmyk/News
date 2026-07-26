'use strict';

const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { createHttpServer } = require('./http');

const config = loadConfig();
const db = openDatabase(config.dbPath);
const server = createHttpServer({ db, config });

server.listen(config.port, config.host, () => {
  process.stdout.write(`Policy monitor listening on http://${config.host}:${config.port}\n`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`Received ${signal}; shutting down\n`);
  const forceTimer = setTimeout(() => process.exit(1), 10_000);
  forceTimer.unref();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
