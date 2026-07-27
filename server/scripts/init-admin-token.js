#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function tokenPath(argv) {
  const index = argv.indexOf('--path');
  if (index === -1 || !argv[index + 1]) throw new Error('--path is required');
  return path.resolve(argv[index + 1]);
}

function initialize(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o750 });
  if (fs.existsSync(filename)) {
    const current = fs.readFileSync(filename, 'utf8').trim();
    if (current.length < 32 || current.length > 512 || /[^\x21-\x7e]/.test(current)) {
      throw new Error('existing admin token is invalid; refusing to replace it automatically');
    }
    fs.chmodSync(filename, 0o600);
    return false;
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(filename, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(filename, 0o600);
  return true;
}

function main() {
  const filename = tokenPath(process.argv.slice(2));
  const created = initialize(filename);
  process.stdout.write(`Admin access token ${created ? 'created' : 'preserved'} at ${filename}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Admin token initialization failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { initialize, main, tokenPath };
