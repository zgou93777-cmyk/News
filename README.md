# 政知镜 · 政策跟踪与复盘

政知镜由静态前端、Node.js API、SQLite 数据库和定时政策采集器组成。系统保存官方原文、不可变分析版本、政策脉络、执行证据、预测与复核记录。

## 目录

- `frontend/`：响应式 Web/PWA 前端。
- `server/`：HTTP API、SQLite schema、种子数据和通知。
- `collector/`：官方来源发现、抓取、相关性审核和分析流水线。
- `config/`：官方来源配置。
- `deploy/`：systemd、Nginx、环境变量和证书辅助脚本。
- `METHODOLOGY.md`：事实、解释、预测和复核口径。

## 运行要求

- Node.js 24.13 或更高版本。
- 生产环境使用 HTTPS。
- API 运行依赖 `server/package-lock.json` 中的 `web-push`。

```bash
cd server
npm ci
npm run init-db
npm run seed
npm test
npm start
```

另开终端验证采集器：

```bash
cd collector
npm test
node src/cli.js --url 'https://www.gov.cn/zhengce/content/202607/content_7075216.htm' --dry-run --analysis rules --no-notify
```

## 生产部署

生产配置统一保存到 `/etc/policy-monitor/policy-monitor.env`。源码目录默认为 `/opt/policy-monitor`，运行账号默认为 `policy-monitor`，数据库目录为 `/var/lib/policy-monitor`。

```bash
sudo install -d -m 0750 /etc/policy-monitor
sudo install -m 0600 deploy/policy-monitor.env.example /etc/policy-monitor/policy-monitor.env
sudo cp deploy/policy-monitor.service /etc/systemd/system/
sudo cp deploy/policy-monitor-alert@.service /etc/systemd/system/
sudo cp collector/systemd/policy-monitor-collector.service /etc/systemd/system/
sudo cp collector/systemd/policy-monitor-collector.timer /etc/systemd/system/
sudo cp collector/systemd/policy-monitor-historical.service /etc/systemd/system/
sudo cp collector/systemd/policy-monitor-historical.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now policy-monitor.service policy-monitor-collector.timer policy-monitor-historical.timer
```

Nginx 配置位于 `deploy/xw.http.nginx.conf` 和 `deploy/xw.https.nginx.conf`。启用 HTTPS 前需先准备对应证书路径。

## 上线检查

```bash
curl --fail http://127.0.0.1:5191/api/health
systemctl status policy-monitor.service --no-pager
systemctl status policy-monitor-collector.timer --no-pager
journalctl -u policy-monitor.service -u policy-monitor-collector.service --since today
```

`.env`、SQLite 数据库、日志、`node_modules` 和通知密钥不进入源码包。生产数据库需要单独备份。
