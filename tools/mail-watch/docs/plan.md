# 代表宛メール見落とし防止AI秘書（mail-watch）進捗表

> 仕様書: [spec.md](spec.md)
> 開始日: 2026-07-17

## スプリント一覧

| グループ | # | 作業内容 | 状態 |
|---------|---|---------|------|
| 基盤 | 1-1 | Wranglerプロジェクト作成・D1スキーマ（emails / action_logs） | 未着手 |
| 基盤 | 1-2 | Gmail API 疎通（refresh token→access token・メール検索/取得） | 未着手 |
| 基盤 | 1-3 | 取得メールのD1保存＋gmail_id重複排除（Cron 5分毎） | 未着手 |
| AI | 2-1 | Gemini API で要約・期限・緊急度・宛先分類（JSON出力）→D1保存 | 未着手 |
| 通知 | 3-1 | LINE push通知（Flex Message・Gmailリンク・管理画面リンク） | 未着手 |
| 通知 | 3-2 | 通知履歴の記録（action_logs・notify_count） | 未着手 |
| 管理画面 | 4-1 | パスコード認証＋メール一覧（ステータス別タブ） | 未着手 |
| 管理画面 | 4-2 | ステータス更新（確認済み/対応中/完了）＋操作履歴表示 | 未着手 |
| 再通知 | 5-1 | 未確認×3時間で再push（上限2回・Cron 30分毎） | 未着手 |
| 仕上げ | 6-1 | 本番デプロイ（wrangler deploy・secret登録・動作確認） | 未着手 |

## 人間側のタスク

- [ ] Google Cloud プロジェクト作成＋Gmail API 有効化
- [ ] OAuth同意画面を「外部・本番公開」に設定（テストモードだとトークンが7日で失効）
- [ ] OAuthクライアント作成＋refresh token 取得（取得手順はスプリント1-2で用意する）
- [ ] LINE Messaging API チャネル作成＋長期アクセストークン発行
- [ ] 代表の LINE userId 取得
- [ ] Cloudflare アカウント作成（無料）
- [ ] Gemini API キー取得（Google AI Studio）
- [ ] 管理画面パスコードの値を決める

## メモ

- 運用コストは月額0円が前提（Cloudflare無料枠・Gemini無料枠・LINE無料枠200通/月）
- LINE通知はpush専用でWebhookは使わない。操作はすべてWeb管理画面側
- スプリント1-2の完了時点で refresh token 取得用の使い捨てスクリプトを用意し、人間側タスクを進められるようにする
