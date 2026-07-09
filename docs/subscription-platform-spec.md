# マジックアプリ サブスクリプションプラットフォーム 仕様書

> ステータス: 構想・壁打ち段階（決済連携・Discord連携は未着手）
> 最終更新: 2026-07-09

## コンセプト

日常で使っているスマホが、そのままマジックの道具箱になる。
株式会社なんで屋のマジックアプリ群を1つのサブスクリプションで束ねて提供する。

## 対象アプリ

| アプリ | ディレクトリ | 種別 | 現状のライセンス機構 |
|---|---|---|---|
| ストップウォッチ | `apps/stopwatch` | 数字予言系フォース | あり（`licenses`） |
| 電卓 | `apps/calc` | 電卓フォース | あり（`calc_licenses`） |
| Re:Time | `apps/clock` | 時間巻き戻し系フォース | あり（`clock_licenses`） |
| CIPHER | `apps/lockscreen` | ロック画面フォース | あり（`cipher_licenses`） |
| Magic Bar | `apps/proxy-magician` | ― | なし（認証・課金機構が未実装） |

今後もアプリは追加予定。追加アプリは原則サブスク会員のみが利用できる形にする。

## 料金プラン

- 月額 550円（応援価格）
- 年払い 5,500円
- 買い切りプランは検討したが**撤回。サブスク一本**とする（2026-07-09決定）
  - 理由: プラットフォーム型（今後アプリが増え続ける）という設計思想と、買い切りは相性が悪く、対象範囲の線引きが常に問題になるため。

## 全体構成

- Firebaseプロジェクトは既存の `nandeya-magic-app` を共有（新規プロジェクトは作らない）
- 決済はStripe Checkout + Webhookを想定（**未着手**）
- コミュニティ運営はDiscord。有料会員へのロール自動付与を行う（**中身は未検討、今後詰める**）

## データモデル

### `members` コレクション（新設）

```
members/{memberId}          // memberId = Stripe customerId を想定
{
  email: string,
  stripeCustomerId: string,
  stripeSubscriptionId: string,
  plan: "monthly" | "yearly",
  status: "active" | "past_due" | "canceled",
  currentPeriodEnd: Timestamp,   // 実質的な有効期限
  discordUserId: string | null,  // 未連携時はnull
  createdAt: Timestamp,
  updatedAt: Timestamp,
}
```

- 全アプリ共通の1レコードで、プラットフォーム全体へのアクセス権を表す（アプリ個別の権限フラグは持たない）
- 失効判定: `status === "active"` かつ `currentPeriodEnd > now`

### 既存の `xxx_licenses` コレクション（変更なし＋フィールド追加）

各アプリの既存ライセンス構造 `{ID, passcode, deviceId, createdAt, note}` はそのまま維持し、以下を追加する。

```
ownerEmail: string
memberId: string   // members/{memberId} への参照
```

既存のID・パスコード方式のログイン体験は変更しない。ユーザーは今まで通りID・パスコードでログインする。

## 購入〜利用のフロー

1. ユーザーがStripe Checkoutでサブスク購入（email入力）
2. Stripe Webhook（`checkout.session.completed`）→ Cloud Functionsが発火
3. `members/{stripeCustomerId}` を作成
4. 同じFunctionが5アプリ分のID・パスコードを自動発番し、各 `xxx_licenses` に `ownerEmail` / `memberId` 付きで書き込む
5. 発行されたID・パスコード一式をメール（またはDiscord DM）で本人に送付
6. ユーザーは各アプリで今まで通りID・パスコードでログイン（deviceId初回登録も既存フローのまま）

## ログイン時の追加チェック

既存の「ID→passcode照合→deviceId照合」の**前段**に以下を挟む。

```
xxx_licenses/{ID}.memberId → members/{memberId} を取得
→ status === "active" && currentPeriodEnd > now を確認
→ NGなら「サブスクが失効しています」を表示してログイン拒否
```

## サブスク更新・失効

- Stripeの `customer.subscription.updated` / `deleted` イベントで `members` の `status` と `currentPeriodEnd` を更新するのみ
- `xxx_licenses`（ID・パスコード・deviceId）には一切手を触れない
  - 失効してもID自体は残るため、再入会時に同じIDを再利用できる

## Discord連携

- `members.status` が `active → canceled` に変わったタイミングで、Discord Bot APIを叩きロールを剥奪する（Functionsから実行）
- `discordUserId` は購入時点ではなく、本人がDiscordサーバー内で連携コマンドを実行した際に後から書き込む想定
- チャンネル構成・コンテンツ設計は**別途検討**（今回のスコープ外）

## 既存ユーザーの扱い

現在ID・パスコードを持っているのはデバッグ協力中の知人のみ。データ互換性を気にする必要はなく、自由に移行・リセットしてよい。

## 未決定・今後の検討事項

- 決済連携（Stripe）の実装（**今回は着手しない**）
- Discordのチャンネル構成・運用コンテンツ（**今回は着手しない**）
- Firestoreルールのセキュリティ強化（現状 `passcode` を含め `read: if true` の緩い設計。決済が絡む前に見直すか要検討）
- 特定商取引法に基づく表記の整備
- 解約・返金ポリシー（日割り返金の有無、解約後の利用期限など）
- 無料トライアルの有無
- Magic Bar（`apps/proxy-magician`）への認証機構の新規実装
