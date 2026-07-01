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
