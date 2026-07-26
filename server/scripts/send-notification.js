'use strict';

const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { sendNotification } = require('../src/notifications');

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new Error('Usage: npm run notify -- --title <title> --body <body> [--url <url>] [--article-id <id>]');
    }
    values[name.slice(2)] = value;
  }
  const articleId = values['article-id'] ? Number(values['article-id']) : null;
  if (articleId !== null && (!Number.isSafeInteger(articleId) || articleId < 1)) {
    throw new Error('--article-id must be a positive integer');
  }
  return {
    title: values.title || '',
    body: values.body || '',
    url: values.url || '',
    articleId
  };
}

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  try {
    const result = await sendNotification(db, config, parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`Notification failed: ${error.message}\n`);
  process.exitCode = 1;
});
