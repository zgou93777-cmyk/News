# 政策采集器

这是一个随任务启动、执行完即退出的轻量采集进程。它读取 `../config/sources.json`，抓取官方网页或本地文本，生成可追溯分析并写入后端共用的 SQLite 数据库。默认开启新内容通知；未配置通知环境变量时会安全跳过。

## 分析边界

- 默认 `--analysis auto`。环境中没有完整模型配置时，使用 `rules-based-v1`，并在 `analysis_versions.model_name`、`methodology` 和 `evidence_summary` 中明确标注。
- 规则分析只提取原文量化表述、主题词、行动词和条件性语句。它不会把政策方向写成已执行，也不会推断未公开的资金规模、资产价格或删减内容。
- 配置 `MODEL_BASE_URL`、`MODEL_API_KEY`、`MODEL_NAME` 后可调用 OpenAI-compatible `chat/completions`。`auto` 模式在模型不可用时退回规则分析；`model` 模式则明确失败。
- 同 URL 同正文哈希直接跳过；不同 URL 同正文哈希也跳过。原 URL 正文发生变化时更新文档快照，并新增不可变的分析版本。审校种子的占位哈希首次遇到完整官方正文时只静默补全原文，不覆盖审校分析或重复通知。
- 来源页候选先经过严格 URL、来源路径、近三年窗口和政策相关性门槛。动态 JSON 列表只用 `JSON.parse` 读取已知 URL/标题字段，不执行页面 JavaScript。
- 政治局、国务院常务会议、中央经济工作会议、货币政策委员会、正式政策文件、政策发布会和重要宏观数据明确保留；表彰、人事、党建、内控、一般机关活动、泛外交例会和临时救灾拨款默认排除。

## 常用命令

Node.js 需要 24.13 或更高版本。

```bash
cd /opt/policy-monitor/collector

# 使用后端已审校种子建立历史框架；重复运行不会重复插入
node src/cli.js --backfill-seed

# 先预演一个已知官方 URL，不写库、不通知
node src/cli.js --url 'https://www.gov.cn/zhengce/content/202607/content_7075216.htm' --dry-run

# 采集一个来源的最新候选链接
node src/cli.js --source gov-policy --max-items 10

# 扫描 sources.json 中全部启用来源
node src/cli.js --all-sources --max-items 20

# 导入人工保存的官方原文；原始 URL 用于去重与证据回链
node src/cli.js --file /tmp/policy.txt --source gov-policy \
  --original-url 'https://www.gov.cn/example.htm' --published-at 2026-07-20

# 强制只用规则分析并暂不通知
node src/cli.js --url 'https://www.gov.cn/example.htm' --analysis rules --no-notify

# 审计既有自动采集记录；默认只预览
node src/cli.js --reconcile-relevance --dry-run

# 人工核对预览 JSON 后再显式执行状态降级
node src/cli.js --reconcile-relevance --apply
```

相关性修复不删除数据。`--apply` 只把未通过门槛的自动采集文档设为 `draft`、把重要性降为 `1`，并新增“采集相关性复核：低相关降级”歧义记录。原文、URL、分析版本、预测和已有证据全部保留；重复执行不会重复写审计记录。

若页面不能稳定提取标题、发布机构或发布日期，采集器会拒绝入库，并要求通过 `--title`、`--issuer`、`--published-at` 补足，不会用当前时间冒充发布日期。

## 环境变量

```dotenv
DB_PATH=/opt/policy-monitor/server/data/policy-monitor.db
PUBLIC_BASE_URL=https://policy.example.com

# 可选模型；三个值必须同时存在
MODEL_BASE_URL=https://model.example.com/v1
MODEL_API_KEY=
MODEL_NAME=

# 可选通知；秘密只放服务器环境文件，不进入仓库或日志
DINGTALK_WEBHOOK=
DINGTALK_SECRET=
VAPID_SUBJECT=mailto:admin@example.com
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
```

建议保存为 `/etc/policy-monitor/policy-monitor.env`，由 root 创建并执行 `chmod 600`。systemd 会在降权启动服务前读取它。钉钉密钥、模型密钥和 Web Push 订阅端点都不会被采集器打印。

```bash
sudo install -d -m 0750 /etc/policy-monitor
sudo install -m 0600 ../deploy/policy-monitor.env.example /etc/policy-monitor/policy-monitor.env
```

## 定时运行

仓库内提供 `systemd/policy-monitor-collector.service` 和 `.timer`。部署目录为 `/opt/policy-monitor`、服务账号为 `policy-monitor` 时：

```bash
sudo cp systemd/policy-monitor-collector.service /etc/systemd/system/
sudo cp systemd/policy-monitor-collector.timer /etc/systemd/system/
sudo cp ../deploy/policy-monitor-alert@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now policy-monitor-collector.timer
sudo systemctl start policy-monitor-collector.service
sudo systemctl status policy-monitor-collector.service --no-pager
```

定时器每个偶数小时的 15 分运行一次，并在关机错过后补跑。常驻的是 systemd 定时器，不是 Node 进程；平时只占极少的定时器元数据，采集期间才短时占用 CPU 和内存。服务限制为最多 320 MiB 内存、10 分钟执行时间。

API 或采集任务异常退出时，`policy-monitor-alert@.service` 会使用同一套受保护环境变量发送钉钉告警；告警文本不包含 webhook 或签名密钥。

## 验证

```bash
cd /opt/policy-monitor/collector
node --test
node src/cli.js --backfill-seed --dry-run --no-notify
node src/cli.js --url 'https://www.gov.cn/zhengce/content/202607/content_7075216.htm' --dry-run --analysis rules
```

退出码：`0` 表示成功，`2` 表示部分来源失败但已有有效结果，`1` 表示任务失败。每次实际采集会写入 `sync_runs`，便于前端和运维追踪最后成功时间。
