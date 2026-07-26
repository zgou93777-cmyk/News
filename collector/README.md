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

## 1949 至今的历史回填

历史回填与日常采集隔离。发现和提取不会写入公开 `documents` 表，也不会发送通知；自动处理的 HTML 最多进入 `needs_review`。公报 PDF 先进入 `manual_review`，再由独立任务执行缓存、文本提取、逐页 OCR 和文章拆分；拆出的候选文章仍只进入私有 `needs_review`。

```bash
# 读取国务院公报官方导航，记录真实缺口并建立私有队列
node src/cli.js --historical-discover --from-year 1949 --max-items 100

# 每次根据 CPU 和可用内存在 5—100 条之间动态调整；远程请求间隔 5 秒
node src/cli.js --historical-process --adaptive-load --min-items 5 --max-items 100 --delay-ms 5000

# 处理私有 PDF 队列；优先内嵌文本，必要时每份最多新增 OCR 20 页并保存断点
node src/cli.js --historical-pdf-process --adaptive-load --min-items 1 --max-items 5 --ocr-page-budget 20 --delay-ms 5000

# 查看私有队列，不影响首页或公开 API
node src/cli.js --historical-status

# 使用结构化审校文件复核一篇；即使通过也只进入私有 ready 状态
node src/cli.js --historical-review 123 --review-file /secure/reviews/123.json --dry-run
node src/cli.js --historical-review 123 --review-file /secure/reviews/123.json
```

审校文件必须同时包含：官方 `.gov.cn` 原文及补充证据 URL、标题/机构/发文日期、政策生效与废止周期、实施和结果证据状态、逐字证据摘录、分析摘要、歧义、审校说明和审校人。会议或文件表态不能作为实施证据；“未找到结果证据”必须明确记录为 `not_found`，不能改写成已兑现。数据库触发器会拒绝把字段不完整的条目标记为 `ready` 或 `published`。

当前国务院公报官方导航始于 1954 年，且未列出 1967—1979 年；1949—1953 年需要另行寻找中央人民政府时期官方档案。因此首页只显示实际通过核验的最早和最晚年份，不宣称已经完整覆盖 1949 至今。

相关性修复不删除数据。`--apply` 只把未通过门槛的自动采集文档设为 `draft`、把重要性降为 `1`，并新增“采集相关性复核：低相关降级”歧义记录。原文、URL、分析版本、预测和已有证据全部保留；重复执行不会重复写审计记录。

若页面不能稳定提取标题、发布机构或发布日期，采集器会拒绝入库，并要求通过 `--title`、`--issuer`、`--published-at` 补足，不会用当前时间冒充发布日期。

## 环境变量

```dotenv
DB_PATH=/opt/policy-monitor/server/data/policy-monitor.db
HISTORICAL_CACHE_DIR=/var/lib/policy-monitor/historical-cache
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

仓库内提供日常采集和历史低速队列两组 systemd 单元。部署目录为 `/opt/policy-monitor`、服务账号为 `policy-monitor` 时：

```bash
sudo cp systemd/policy-monitor-collector.service /etc/systemd/system/
sudo cp systemd/policy-monitor-collector.timer /etc/systemd/system/
sudo cp systemd/policy-monitor-historical.service /etc/systemd/system/
sudo cp systemd/policy-monitor-historical.timer /etc/systemd/system/
sudo cp ../deploy/policy-monitor-alert@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now policy-monitor-collector.timer policy-monitor-historical.timer
sudo systemctl start policy-monitor-collector.service
sudo systemctl status policy-monitor-collector.service --no-pager
```

日常采集定时器每个偶数小时的 15 分运行一次；历史队列每小时设置一个窗口，先从官方导航补充下一批最多 100 个未入队期号，再根据 CPU 一分钟负载和可用内存动态处理 5—100 条。PDF 期号只做本地私有分流，不等待；需要访问官方站点的 HTML 和文章保持 5 秒请求间隔。低负载时一天理论可推进约 2400 个队列项，任务执行中负载升高会提前结束本批次。抓取和公开核验仍严格分离，处理速度提高不会让未经审校的内容提前展示。

API 或采集任务异常退出时，`policy-monitor-alert@.service` 会使用同一套受保护环境变量发送钉钉告警；告警文本不包含 webhook 或签名密钥。

## 验证

```bash
cd /opt/policy-monitor/collector
node --test
node src/cli.js --backfill-seed --dry-run --no-notify
node src/cli.js --url 'https://www.gov.cn/zhengce/content/202607/content_7075216.htm' --dry-run --analysis rules
```

退出码：`0` 表示成功，`2` 表示部分来源失败但已有有效结果，`1` 表示任务失败。每次实际采集会写入 `sync_runs`，便于前端和运维追踪最后成功时间。
