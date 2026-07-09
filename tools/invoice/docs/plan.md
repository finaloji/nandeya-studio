# 見積書・請求書ツール v2 進捗表

> 仕様書: [spec.md](spec.md)
> 開始日: 2026-07-08

## スプリント一覧

| グループ | # | 作業内容 | 状態 |
|---------|---|---------|------|
| 基本UI | 1-1 | 入力フォームの骨組み（書類タイプ切替・宛先・日付） | 完了 |
| 基本UI | 1-2 | 明細行の追加・削除と金額計算（交通費非課税ルール） | 完了 |
| 基本UI | 1-3 | 備考欄とデフォルト文（振込先） | 完了 |
| 帳票 | 2-1 | 帳票プレビュー（ひな型レイアウト再現） | 完了 |
| 帳票 | 2-2 | PDF出力（印刷CSS・A4縦） | 完了 |
| Firebase | 3-1 | Firebase初期化とパスコード認証 | 完了 |
| Firebase | 3-2 | 料金マスタの読み込み＋マジシャン別かんたん入力 | 完了 |
| Firebase | 3-3 | 料金マスタ編集画面 | 完了 |
| 案件管理 | 4-1 | 案件の保存（Firestoreへ書き込み） | 完了 |
| 案件管理 | 4-2 | 案件一覧の表示・再編集・複製・削除 | 完了 |
| 案件管理 | 4-3 | ステータス管理（変更UI・一覧の絞り込み） | 未着手 |
| 案件管理 | 4-4 | 見積書→請求書の変換 | 未着手 |
| 仕上げ | 5-1 | 下書き自動保存（localStorage） | 未着手 |
| 仕上げ | 5-2 | PWA対応（manifest・アイコン） | 未着手 |

## 人間側のタスク

- [x] Firebase プロジェクトの新規作成（invoice-tool-1f049・Firestore有効化済み）
- [x] 共通パスコードの値を決める（決定済み。コードにはSHA-256ハッシュのみ記載）
- [x] Firestoreセキュリティルールの設定（`invoice/master` の読み書きを許可済み）
- [x] Firestoreセキュリティルールに `cases` コレクションを追加済み

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /invoice/{docId} {
      allow read, write: if true;
    }
    match /cases/{caseId} {
      allow read, write: if true;
    }
  }
}
```

## メモ

- 旧ツール（index.html）はグループ1の開始時点で全面書き換えとなる
- グループ1〜2は Firestore なしで動く。Firebase 未準備でも進められる
