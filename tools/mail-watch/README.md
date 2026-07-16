# mail-watch

代表宛メール見落とし防止AI秘書（Cloudflare Workers + D1）。

Gmail からメールを取り込み、AI で要約・分類し、LINE に通知するツール。
現在はスプリント 1-1（プロジェクト雛形 + DB スキーマ）まで完了した状態で、
メール取得・AI 要約・LINE 通知・管理画面は未実装。

詳細仕様は `docs/spec.md`、進捗は `docs/plan.md` を参照。

## 前提ツール

- Node.js 18 以上（npm 同梱）
- Cloudflare アカウントへのログインは**不要**（ローカル開発は完全ローカルで動く）

## セットアップと動作確認の手順

すべて `tools/mail-watch/` 配下で実行する。

### 1. 依存関係の導入

```
npm install
```

### 2. スキーマをローカル DB に適用

```
npm run db:migrate:local
```

- `migrations/0001_init.sql` がローカル D1（`.wrangler/` 配下の SQLite ファイル）に適用される
- **再実行しても安全**。D1 のマイグレーション管理により、適用済みのマイグレーションはスキップされる
- 初回実行時に「Migrations to be applied: 0001_init.sql」のような表示が出れば成功

### 3. テーブルが作成されたことを確認

```
npm run db:tables:local
```

`emails` と `action_logs` の 2 テーブル（および D1 の管理テーブル `d1_migrations` 等）が表示されれば OK。

### 4. 開発サーバーの起動と応答確認

```
npm run dev
```

`http://localhost:8787` が立ち上がるので、ブラウザか curl でアクセスする。

```
curl http://localhost:8787/
```

期待される出力（ステータス 200）:

```json
{"name":"mail-watch","status":"ok","message":"mail-watch は稼働中です"}
```

なお、スキーマ未適用でも起動・応答は可能（現時点では DB を参照しないため）。
手順は「導入 → スキーマ適用 → 起動確認」の順を推奨。

### Cron の動作確認（任意）

`wrangler dev` 実行中に別ターミナルから発火をエミュレートできる。

```
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+23+*+*+*"
```

dev サーバー側のコンソールに「5分毎Cron発火」「毎朝8時JST Cron発火」のログが出る。

## プロジェクト構成

| ファイル | 役割 |
|---------|------|
| `wrangler.jsonc` | Worker 設定（名前・エントリポイント・D1 バインディング・Cron 2 本） |
| `package.json` | 依存と npm scripts（`dev` / `db:migrate:local` / `db:tables:local` / `typecheck`） |
| `tsconfig.json` | Workers ランタイム向け TypeScript 設定 |
| `migrations/0001_init.sql` | 初期スキーマ（emails / action_logs）。以降のスキーマ変更は `migrations/` に連番ファイルを追加して積み上げる |
| `src/index.ts` | エントリポイント（HTTP: 稼働確認応答、Cron: 発火ログのみ） |
| `.dev.vars.example` | ローカル開発用シークレットのサンプル（キー名のみ） |
| `.gitignore` | `node_modules/` / `.wrangler/`（ローカル DB 実体）/ `.dev.vars` を除外 |

## Cron Triggers

Cron は **UTC 指定**（`wrangler.jsonc` の `triggers.crons`）。

| パターン | 意味 | 用途（予定） |
|---------|------|------------|
| `*/5 * * * *` | 5 分毎 | メール取得・通知の定期実行 |
| `0 23 * * *` | UTC 23:00 = **JST 8:00** | 毎朝のダイジェスト通知 |

## データベース

- D1（SQLite 互換）。バインディング名は `DB`、データベース名は `mail-watch-db`
- **日時はすべて UTC 基準で保存**し、表示時に JST へ変換する方針
- `emails.gmail_id` の UNIQUE 制約が二重取り込み防止の要
- `urgency` / `target` / `status` / `action` は CHECK 制約により定義外の値を DB レベルで拒否する

### 本番 D1 について（未作成・スコープ外）

`wrangler.jsonc` の `database_id` は本番 D1 未作成のため**プレースホルダー**になっている。
ローカル開発はこのままで動作する。本番デプロイ時には以下を行うこと。

```
wrangler d1 create mail-watch-db
```

で作成した ID を `wrangler.jsonc` の `database_id` に設定し、
`wrangler d1 migrations apply mail-watch-db --remote` でスキーマを適用する。

## シークレット（未設定でも起動可）

以下の 7 つを将来使用する。**スプリント 1-1 時点では未設定のままで問題なく動作する。**

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` — Gmail API
- `GEMINI_API_KEY` — AI 要約
- `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_TARGET_USER_ID` — LINE 通知
- `ADMIN_PASSCODE_HASH` — 管理画面認証

設定方法（将来の予告）:

- **ローカル**: `.dev.vars.example` を `.dev.vars` にコピーして値を記入（`.dev.vars` は Git 除外済み）
- **本番**: `wrangler secret put <名前>` で登録

### Gmail の refresh token 取得（`scripts/get-refresh-token.mjs`）

OAuth 同意画面を「本番公開」した状態で、Google Cloud の認証情報ページで取得した
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を使い、ブラウザ認可を経て refresh token を取得する使い捨てスクリプト。
（同意画面をテストモードのままにすると refresh token が 7 日で失効するため、本番公開が前提）

```
GOOGLE_CLIENT_ID=<クライアントID> GOOGLE_CLIENT_SECRET=<クライアントシークレット> node scripts/get-refresh-token.mjs
```

表示された URL をブラウザで開き、対象の Gmail アカウントで認可する
（「このアプリは確認されていません」の警告は「詳細」→「（アプリ名）に移動」で進めてよい）。
コンソールに `refresh_token` が出力されるので、`.dev.vars` の `GOOGLE_REFRESH_TOKEN` に設定する。
