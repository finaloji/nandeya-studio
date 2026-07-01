# nandeya-studio

株式会社なんで屋のアプリ・ツール開発リポジトリ。

## プロジェクト構成

```
apps/
  stopwatch/        — ストップウォッチフォース（マジックアプリ）
tools/
  invoice/          — 見積書・請求書作成ツール
  blog/             — 出張レポートブログ作成ツール
```

## ブログ作成ツールを使う際のルール

記事を作成・修正するときは、必ず以下を確認すること。

- @tools/blog/docs/blog-rules.md
- @tools/blog/docs/company-info.md
- @tools/blog/examples/

### 最重要ルール

- 事実として入力されていない情報を勝手に作らない
- 会場名、人名、日付、人数、料金を推測しない
- 不明な情報は本文に無理に入れない
- 過度に大げさな表現を使わない
- 株式会社なんで屋らしい、親しみやすく丁寧な文章にする
- SEOを意識するが、不自然なキーワードの詰め込みはしない
- Wixへは最初から公開せず、原則として下書き保存する

## 技術情報

- 純粋なHTML/CSS/JavaScriptで構成（フレームワーク不使用）
- モバイルファーストのレスポンシブデザイン
- GitHub Pages でホスティング（https://finaloji.github.io/nandeya-studio/）
- 公式サイトはWix（WordPress不使用）
- Firebase Firestore を使用（Firebase Auth は不使用。独自ID/パスコード方式でライセンス管理）
- PWA対応（manifest.json、apple-touch-icon）

## ストップウォッチアプリの設計方針

### 難読化ルール（最重要）

このアプリはマジシャンが使う秘密のツールのため、コードを見てもフォース機能の存在がわからないようにする。

- localStorage キーは意味のない名前にする（`_dcc`, `_tcm`, `_tcv`, `_lfc` など）
- 関数名も同様に難読化する（`dcc()`, `glf()` など）
- UI上のラベルは「表示設定」「数値補正」など、マジックのネタがバレない言葉を使う
- 新機能を追加するときもこの方針を維持すること

### 既知の技術的注意点

- `type="module"` スクリプトはDOMより後に実行されるため、Firebase の初期化タイミングに注意。`_fsready` カスタムイベントで同期している
- iOSのnumeric inputはEnterキーが発火しないため、決定ボタンを明示的に設置すること

### 公開URL

- ストップウォッチ: https://finaloji.github.io/nandeya-studio/apps/stopwatch/stopwatch.html
- 管理画面: https://finaloji.github.io/nandeya-studio/apps/stopwatch/admin.html

## 開発フロー

3エージェント構成（Planner → Generator → Human Review）で開発する。
`/sprint` コマンドで起動できる。詳細は `apps/stopwatch/docs/dev-workflow.md` を参照。
