# Firestoreセキュリティルール

## 目的

開発初期は動作確認を優先し、Firestoreのセキュリティルールを以下のような「すべて許可」の状態にしていた。

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
```

この状態では、Firestoreのプロジェクト設定（projectId・apiKeyなど）さえ分かれば、誰でも全コレクションを自由に読み書きできてしまう。本ドキュメントでは、`firestore.rules`に定義した本番向けの制限付きルールについて、内容と適用手順をまとめる。

ID・パスコード認証や端末ロックの仕組み自体は `docs/auth-spec.md` を参照。

## ルールの内容

### licenses コレクション

| 操作 | 結果 | 理由 |
|------|------|------|
| 読み取り | 許可 | stopwatch.htmlのログイン時にID・パスコードを照合するため、クライアントから読み取れる必要がある |
| 作成（create） | 条件付き許可 | 既存のドキュメントIDを上書きする形での新規作成（＝既存ライセンスの乗っ取り）を防ぐため、`resource == null`（同名IDが未使用）の場合のみ許可。あわせて`passcode`が文字列、`deviceId`がnull、`note`が文字列であることを確認する |
| 更新（update） | 条件付き許可 | 端末登録・端末ロック解除では`deviceId`のみを書き換える想定のため、変更されたフィールドが`deviceId`のみであることをチェックする。`passcode`・`createdAt`・`note`を書き換える更新処理はアプリ内に存在しないため、これらが変更される更新はルール側で拒否する |
| 削除（delete） | 許可 | admin.htmlのライセンス削除機能のため許可 |

### deviceChangeRequests コレクション

| 操作 | 結果 | 理由 |
|------|------|------|
| 読み取り | 許可 | admin.htmlの申請一覧表示に必要なため許可 |
| 作成（create） | 条件付き許可 | 端末変更リクエスト送信時のみを想定。フィールドが`licenseId`・`requestedAt`・`status`の3つのみであること、型が正しいこと、`status`が`"pending"`で作成されることを確認する |
| 更新（update） | 条件付き許可 | 申請承認処理（`status: "pending"` → `"approved"`）のみを許可。承認以外の値への変更や、`status`以外のフィールドの変更は拒否する |
| 削除（delete） | 拒否 | 申請履歴を残す運用のため、削除は不可とする |

### それ以外のすべてのコレクション・ドキュメント

| 操作 | 結果 | 理由 |
|------|------|------|
| 読み取り・書き込み | 拒否 | 想定外のコレクションへのアクセスを一律でブロックする |

## 何を防いでいて、何は防げていないか

### 防げているもの

- `licenses`・`deviceChangeRequests`以外の無関係なコレクションへの読み書き
- `licenses`ドキュメントの上書き作成（既存IDを使った乗っ取り作成）
- `licenses`の`passcode`・`createdAt`・`note`の不正な書き換え（`deviceId`以外は更新不可）
- `deviceChangeRequests`を不正な`status`値（`pending`以外）で新規作成すること
- `deviceChangeRequests`の承認（`pending`→`approved`）以外の更新（例: `approved`から別の値への変更や、`licenseId`・`requestedAt`の改ざん）

### 防げていないもの

- admin.html由来の操作かstopwatch.html由来の操作かを、Firestoreルール側で区別できない点。本アプリにはFirebase Authenticationなどの認証基盤がなく、ルールはあくまで「どんなデータ構造の変更を許すか」しか制御できない。admin.htmlのアクセス制限はアプリ側の簡易パスワードのみに依存している
- `licenses`の`passcode`が、ルール上は誰でも読み取り可能な状態である点。小規模・信頼ベースでの運用を前提に、利便性を優先して許容している（`docs/auth-spec.md`の「注意事項」と同じ方針）

## 適用手順

1. Firebase Console（https://console.firebase.google.com/）を開き、対象プロジェクト（`nandeya-magic-app`）を選択する
2. 左メニューから「Firestore Database」を開く
3. 上部タブの「ルール」を選択する
4. `firestore.rules`の内容をすべてコピーし、エディタの内容を置き換える
5. 「公開」ボタンをクリックして反映する

## 適用後の動作確認チェックリスト

ルール公開後、以下の動作を実際にアプリ上で確認する。

### stopwatch.html

- [ ] ログイン成功（未登録端末の初回登録）
- [ ] ログイン拒否（他端末使用中）
- [ ] ログイン拒否（ID/パスコード誤り）
- [ ] 自動ログイン（リロード時）
- [ ] 端末変更リクエストの送信
- [ ] 重複申請時のエラー表示

### admin.html

- [ ] ID発行（新規）
- [ ] ID発行時の重複ID拒否
- [ ] 一覧表示
- [ ] 端末登録リセット
- [ ] 申請承認
- [ ] ライセンス削除
