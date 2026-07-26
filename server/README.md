# Policy Monitor Server

Low-memory Node.js service for the policy news page. It uses the Node 24 built-in `node:sqlite` module, the native HTTP server, and only one runtime package (`web-push`). Nginx is expected to terminate TLS and proxy `/policy/` to `127.0.0.1:5191` with the prefix removed.

## Runtime

- Node.js 24.13 or newer
- HTTPS at the public origin (required by Web Push and iOS home-screen notifications)
- A writable directory for the SQLite database

```bash
cd server
npm install --omit=dev
cp .env.example .env
npm run init-db
npm run seed
npm start
```

The server listens on `127.0.0.1:5191` by default and serves `../frontend` at `/`. Use a root-only environment file in production; do not commit it.

## Environment

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Listener, default `127.0.0.1:5191` |
| `DB_PATH` | SQLite file, default `server/data/policy-monitor.db` |
| `FRONTEND_DIR` | Static frontend directory, default `../frontend` |
| `VAPID_SUBJECT` | Contact URI, normally `mailto:...` |
| `VAPID_PUBLIC_KEY` | Public browser push key |
| `VAPID_PRIVATE_KEY` | Private browser push key |
| `DINGTALK_WEBHOOK` | Full DingTalk robot webhook |
| `DINGTALK_SECRET` | DingTalk signing secret |

Generate a VAPID pair after installing dependencies:

```bash
npm run generate-vapid
```

Store the output in the protected production environment file. The API only returns the public key.

The production units in `../deploy` read `/etc/policy-monitor/policy-monitor.env` and use
`policy-monitor-alert@.service` to send a DingTalk alert when either the API or collector unit fails.

## API

- `GET /api/health`
- `GET /api/categories`
- `GET /api/articles?q=&category=&status=&page=1&pageSize=12`
- `GET /api/articles/:id`
- `GET /api/push/public-key`
- `POST /api/push/subscribe`
- `DELETE /api/push/subscribe`

The detail endpoint returns the article plus immutable analysis history, policy-family comparisons, original and implementation evidence, forecasts with verification states, ambiguity notes, and assessment snapshots.

The subscribe endpoint accepts either a standard PushSubscription JSON object or the frontend envelope:

```json
{
  "subscription": {
    "endpoint": "https://push-service.example/subscription-id",
    "expirationTime": null,
    "keys": {
      "p256dh": "...",
      "auth": "..."
    }
  }
}
```

## Send a notification

The command sends to DingTalk and all active Web Push subscriptions. Expired browser subscriptions (`404`/`410`) are removed automatically.

```bash
npm run notify -- \
  --title '扩大消费“十五五”规划：新增复盘' \
  --body '住房相关条款出现配套进展，原判断已增加验证记录。' \
  --url 'https://example.com/policy/#/articles/3' \
  --article-id 3
```

## Nginx prefix proxy

The trailing slash on `proxy_pass` is intentional: it removes `/policy/` before forwarding.

```nginx
location = /policy {
    return 301 /policy/;
}

location /policy/ {
    proxy_pass http://127.0.0.1:5191/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## Data integrity

`analysis_versions` has database triggers that reject `UPDATE` and `DELETE`. A changed interpretation must be inserted as a new version linked through `previous_version_id`. Policy documents, forecasts, evidence events, ambiguities, and dated assessment snapshots keep the original text separate from interpretation and later verification.

The included seed is idempotent and contains the verified public metadata for 国函〔2026〕66号. The source page's “本文有删减” notice and the interpretation boundary around housing are retained explicitly.

## Tests

```bash
npm test
```

The test suite uses only an in-memory database and a temporary local HTTP listener. It does not send external notifications.
