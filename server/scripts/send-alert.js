'use strict';

const { loadConfig } = require('../src/config');
const { sendDingTalk } = require('../src/notifications');

function buildAlert(unitName) {
  const unit = String(unitName || 'unknown')
    .replace(/[^A-Za-z0-9@_.:-]/g, '?')
    .slice(0, 200);
  return {
    title: '政知镜服务异常',
    body: `systemd 单元 ${unit} 运行失败，请登录服务器检查 systemctl status 和 journalctl 日志。`,
    url: ''
  };
}

async function main() {
  const result = await sendDingTalk(loadConfig(), buildAlert(process.argv[2]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Alert failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildAlert };
