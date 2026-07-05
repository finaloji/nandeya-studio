# Re:Time ライセンス（ID・パスコード認証＋端末ロック）仕様書

## 概要

購入者（マジシャン）のみが Re:Time（時間巻き戻しマジック）を使えるようにする。
ID・パスコードでログインし、1つのIDにつき1台の端末でしか使用できないようにする。
ストップウォッチフォース・電卓フォースと同じ方式（Firestore・独自ID/パスコード、Firebase Auth不使用）で実装する。

- ライセンスは**アプリ別**。Re:Time専用ID。ストップウォッチ／電卓のIDでは開けない。
- 実装は `apps/calc/calc.html` のログインゲートを踏襲し、コレクション名と難読化キーのみRe:Time用に変える。

## Firebase設定（既存プロジェクトを共用）

```js
const firebaseConfig = {
  apiKey: "AIzaSyBSSGdNDndjiUj40m4V4QA6Kjqr-oRnBc8",
  authDomain: "nandeya-magic-app.firebaseapp.com",
  projectId: "nandeya-magic-app",
  storageBucket: "nandeya-magic-app.firebasestorage.app",
  messagingSenderId: "181170873357",
  appId: "1:181170873357:web:b3c3fef8aea6390f37a144"
};
```

## Firestoreのデータ構造（Re:Time専用コレクション）

### コレクション: `clock_licenses`

ドキュメントID = 発行したID（例: `rt001`）

| フィールド | 型 | 説明 |
|-----------|-----|------|
| passcode | string | パスコード |
| deviceId | string \| null | 登録済み端末の識別子。未登録ならnull |
| createdAt | number | 発行日時（Date.now()のミリ秒） |
| note | string | お客様名などのメモ（任意） |

### コレクション: `clock_deviceRequests`

ドキュメントID = 自動採番

| フィールド | 型 | 説明 |
|-----------|-----|------|
| licenseId | string | 対象のID |
| requestedAt | number | 申請日時（Date.now()のミリ秒） |
| status | string | `pending` / `approved` |

## 難読化ルール（Re:Time用の識別子）

マジックアプリのため、キー名・関数名は意味のない略号にする。ストップウォッチ/電卓と衝突しない独自プレフィックス `r`（Re:Time）を使う。

| 用途 | 名前 |
|------|------|
| Firebase DB グローバル | `window.__rdb` |
| Firebase 関数群グローバル | `window.__rfns` |
| 初期化完了イベント | `_rfsready` |
| localStorage: 端末ID | `_rtdev` |
| localStorage: ログイン済みID | `_rtlic` |
| ゲート要素 | `#_rag` |
| ID入力 | `#_rid` / パスコード `#_rpc` / ボタン `#_rlb` / メッセージ `#_rmsg` / 端末変更リンク `#_rdr` |
| 関数 | 端末ID取得 `_grdi` / エラー `_rshe` / 案内 `_rshi` / ボタン状態 `_rslb` / ゲート非表示 `_rhga` / ログイン `_ratl` / 自動ログイン `_rtal` / 端末変更申請 `_rdcr` |

## ログインゲート（clock.html）

### 起動時の流れ
1. `<head>` のモジュールスクリプトで Firebase を初期化し、`window.__rdb` / `window.__rfns` を用意 → `_rfsready` を発火。
2. ゲート（`#_rag`）は初期表示で画面全体を覆う（z-index 200・黒背景）。
3. `_rfsready` 後（または既に準備済みなら即）自動ログイン `_rtal()` を試行。
   - localStorage `_rtlic` があり、その `deviceId` が本端末 `_rtdev` と一致すれば `_rhga()` でゲートを消す。
4. 自動ログイン不可ならゲートを表示したままログイン入力を待つ。

### ログイン処理（`_ratl(id, pass)`）
1. `clock_licenses/{id}` を取得。存在しない or パスコード不一致 → `invalid`。
2. `deviceId` が null（未登録）→ 本端末IDを書き込み → 成功。
3. `deviceId` が本端末IDと一致 → 成功。
4. `deviceId` が別端末 → `device`（別端末で登録済み）。
5. 成功時、localStorage `_rtlic` にIDを保存しゲートを消す。

### 端末識別子（`_grdi`）
- 初回に `rt-{Date.now()}-{random}` を生成して localStorage `_rtdev` に保存。以降はそれを使う。

### 端末変更リクエスト（`_rdcr`）
- ID・パスコードが正しければ `clock_deviceRequests` に `{licenseId, requestedAt, status:'pending'}` を追加。
- 既に同IDのpending申請があれば重複追加しない。
- admin側で承認すると該当ライセンスの `deviceId` が null に戻り、次回ログインで新端末が登録される。

### 見た目
- 電卓ゲートと同じ黒基調のログイン画面。タイトルは「Re:Time」、アイコンは時計モチーフ。
- 演者が初回セットアップ時に一度だけ操作する。以降は端末に記憶され表示されない。

## admin.html への追加

- 既存 admin.html は stopwatch(`licenses`) と calc(`calc_licenses`) を1画面で管理している。
- Re:Time用セクションを calc セクション複製で追加：`clock_licenses` / `clock_deviceRequests`。
- 機能：ID発行（重複チェック）・一覧（ID/パスコード/端末登録有無/メモ/発行日）・削除・端末登録リセット・端末変更申請の承認。

## Firestoreセキュリティルール（追加分）

`firestore.rules` に calc と同型で追加する。

- `clock_licenses`: read 全許可。create は同名ID未存在＋型チェック。update は `deviceId` のみ変更許可。delete 許可（admin無効化用）。
- `clock_deviceRequests`: read 全許可。create は3フィールド＋`status=='pending'`。update は pending→approved の status のみ。delete 拒否。

> ルールは Firebase コンソール（または firebase CLI `deploy`）への反映が別途必要。コードだけでは有効化されない。

## 運用上の注意
- ID・パスコードは平文でFirestoreに保存（小規模・信頼ベース運用のため簡素化）。
- 完全な不正防止ではなく「気軽なコピー・転用を防ぐ」抑止力として設計。

## スプリント分割

| # | 内容 | 状態 |
|---|------|------|
| L0 | 仕様書作成（本ファイル） | 完了 |
| L1 | Firestoreルール追加（`clock_licenses`/`clock_deviceRequests`） | 完了（コンソール反映済み） |
| L2 | clock.htmlにログインゲートUI＋Firebase初期化 | 完了 |
| L3 | ログイン処理・1ID1端末ロック・端末変更申請 | 完了 |
| L4 | admin.htmlにRe:Timeセクション追加 | 完了 |
| L5 | 通し動作確認（発行✓／ログイン✓／端末ロック・変更承認は要確認） | 作業中 |
