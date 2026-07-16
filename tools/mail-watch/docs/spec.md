# 代表宛メール見落とし防止AI秘書（mail-watch）仕様書

> 作成日: 2026-07-17
> ステータス: ドラフト（レビュー中）

## 1. 目的

- 会社のGmailに届く代表宛メールの「伝え忘れ・見落とし」をなくす
- 通知だけでなく「確認済み → 対応中 → 完了」までをシステム上で管理する
- 通知・確認・対応の履歴をDBに残し、「伝えた／聞いていない」問題を解消する

## 2. 利用者・利用環境

| 項目 | 内容 |
|------|------|
| 通知先 | 代表のLINE（公式アカウントからのpush通知） |
| Web管理画面の利用者 | 代表のみ |
| メイン端末 | スマホ（レスポンシブ対応） |
| 運用コスト | **月額0円**（下記の無料枠内で運用する） |

## 3. 技術構成

- **Cloudflare Workers**（無料プラン）にすべて集約する
  - Cron Triggers: メール取得・通知・再通知の定期実行
  - HTTP: Web管理画面の配信とステータス更新API
  - **D1**（SQLite互換）: メール・ステータス・操作履歴の保存
- 言語は **TypeScript**（Workersランタイム。外部との通信はすべてREST/fetch）
- **Gmail API**（REST・読み取り専用スコープ `gmail.readonly`・5分間隔ポーリング）
- **Gemini API 無料枠**（Flash系モデル）で要約・分類（案Bで決定。将来Claude APIへ差し替え可能な構造にする）
- **LINE Messaging API** は **push専用**（Webhook不使用）。確認・完了などの操作はすべてWeb管理画面側で行う
- シークレットは `wrangler secret` で管理（コード・リポジトリに含めない）
- GitHub Pagesは使わない（本ツールのURLは `*.workers.dev`）

### 前提・制約（重要）

| 項目 | 内容 |
|------|------|
| Gmailアカウント | 個人向けGmail（Google One）。OAuth同意画面は「外部」→**本番公開**にする（テストモードのままだとrefresh tokenが7日で失効するため） |
| LINE無料枠 | **push通知は月200通まで**（コミュニケーションプラン）。1日約6通が目安。超過しそうな場合はダイジェスト通知化を検討（未決事項） |
| Gemini無料枠 | 1日あたりのリクエスト上限あり。本用途（1日数十通）では余裕 |

## 4. 処理フロー

```
[Cron 5分毎]
  Gmail API で対象メールを検索・取得
    → D1 に保存（gmail_id UNIQUE で重複排除 → 重複通知防止）
    → Gemini API で 要約・期限・緊急度・宛先分類 を抽出（JSON）
    → 代表宛と判定されたメールを LINE に push 通知（通知履歴を記録）

[Cron 30分毎]
  「未確認（unread）のまま N 時間経過」を検出 → LINE 再通知（回数上限あり）

[Web管理画面（HTTP）]
  パスコード認証 → メール一覧（ステータス別）
  → 確認済み / 対応中 / 完了 ボタンで更新 → 操作履歴を記録
```

## 5. データ設計（D1）

### emails

| カラム | 内容 |
|--------|------|
| id | 主キー |
| gmail_id | GmailのメッセージID（**UNIQUE**・重複排除の要） |
| thread_id | スレッドID（Gmailを開くリンクに使用） |
| subject / from_addr / received_at | 件名・送信者・受信日時 |
| summary | AI要約 |
| deadline | AIが抽出した期限（不明なら null） |
| urgency | 緊急度（high / mid / low） |
| target | 宛先分類（rep=代表宛 / staff / other） |
| status | unread → acknowledged → in_progress → done |
| notify_count / last_notified_at | 通知回数・最終通知日時 |

### action_logs

| カラム | 内容 |
|--------|------|
| id | 主キー |
| email_id | 対象メール |
| action | notified / re_notified / acknowledged / in_progress / done |
| created_at | タイムスタンプ |

「いつ通知したか」「いつ確認されたか」がここに残ることで、伝達の証跡になる。

## 6. 機能一覧

### 6-1. メール取得（Cron 5分毎）

- Gmail検索クエリで対象を絞り込む（例: `is:important -category:promotions newer_than:2d`。**具体的な条件は未決事項**）
- `gmail_id` の UNIQUE 制約により既取得メールはスキップ（同じメールを重複通知しない）

### 6-2. AI整理（Gemini）

- 入力: 件名・送信者・本文（長文は先頭数千文字に切り詰め）
- 出力（JSON固定）: 要約（2〜3行）／期限（あれば ISO 形式、なければ null）／緊急度（high/mid/low）／宛先分類（rep/staff/other）
- プロンプトは「不明な項目は null と出す」ように固定し、誤った断定をさせない
- 通知対象は宛先分類が `rep`（代表宛）のメールのみ。`staff`/`other` はDBに保存のみ（管理画面では見られる）

### 6-3. LINE通知

- Flex Message のカード型で通知
  - 件名・送信者・要約・緊急度・期限
  - 「Gmailで開く」ボタン → `https://mail.google.com/mail/u/0/#all/<thread_id>`
  - 「管理画面を開く」ボタン
- 送信したら `action_logs` に記録し、`notify_count` を更新

### 6-4. Web管理画面

- パスコード認証（SHA-256ハッシュ照合・認証後はCookieで維持）
- メール一覧をステータス別タブで表示（未確認／確認済み／対応中／完了）
- 各メールに「確認済み」「対応中」「完了」ボタン（操作は `action_logs` に記録）
- 各メールの通知・操作履歴を確認できる

### 6-5. 再通知（Cron 30分毎）

- `status = unread` かつ最終通知から **3時間** 経過したメールを再pushする
- 再通知は **1通あたり最大2回** まで（LINE無料枠の節約。時間・回数は設定値として変更可能にする）

## 7. 環境変数（wrangler secret）

| 変数 | 内容 |
|------|------|
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | Gmail API の OAuth クライアント |
| GOOGLE_REFRESH_TOKEN | 初回認可で取得（本番公開済みアプリのため無期限） |
| GEMINI_API_KEY | Gemini API キー |
| LINE_CHANNEL_ACCESS_TOKEN | Messaging API 長期トークン |
| LINE_TARGET_USER_ID | 代表の userId |
| ADMIN_PASSCODE_HASH | 管理画面パスコードの SHA-256 ハッシュ |

## 8. 人間側の準備タスク

- [ ] Google Cloud プロジェクト作成 → Gmail API 有効化
- [ ] OAuth同意画面（外部）を設定し**本番公開**にする（審査不要。初回認可時の警告は「詳細→続行」で通す）
- [ ] OAuthクライアント作成 → 初回認可フローで refresh token を取得
- [ ] LINE Developers で Messaging API チャネル作成 → 長期アクセストークン発行
- [ ] 代表の userId を取得
- [ ] Cloudflare アカウント作成（無料）
- [ ] Gemini API キーを取得（Google AI Studio）
- [ ] 管理画面パスコードの値を決める

## 9. 未決事項（TODO)

- [ ] 対象メールの Gmail 検索クエリ条件（重要度の判定基準。運用しながら調整する前提で仮の条件で開始してよい）
- [ ] 再通知の間隔・回数の最終値（仮: 3時間・最大2回で開始）
- [ ] LINE月200通を超えそうな場合のダイジェスト通知化
- [ ] Gemini の使用モデル（実装時に無料枠対象の最新 Flash 系を選定）
