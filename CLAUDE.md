# nandeya-studio

株式会社なんで屋のアプリ・ツール開発リポジトリ。
マジシャン向けのマジックアプリ（apps/）と社内業務ツール（tools/）を開発している。

## プロジェクト構成

| パス | 内容 |
|------|------|
| `apps/stopwatch/` | ストップウォッチフォース。`admin.html` は全アプリ共通の管理画面 |
| `apps/calc/` | 電卓フォース |
| `apps/roulette/` | ルーレットフォース |
| `apps/clock/` | 時間巻き戻し時計（clock-force） |
| `apps/lockscreen/` | ロック画面アプリ（CIPHER） |
| `apps/proxy-magician/` | 代打マジシャン（毒舌AIマジシャン） |
| `apps/magcharge/` | VOLT（鼻で充電・MagSafeフォース） |
| `tools/invoice/` | 見積書・請求書作成ツール v2 |
| `tools/blog/` | 出張レポートブログ作成ツール（白紙化中・今後作り直す予定） |
| `docs/` | リポジトリ横断のドキュメント（サブスクプラットフォーム構想、開発フローなど） |

- 各アプリの詳細仕様は `apps/<名前>/docs/` の `*-spec.md`（仕様書）と `*-plan.md`（進捗表）にある。**作業前に必ず対象アプリの仕様書を読むこと。** 進捗や状態はCLAUDE.mdには書かず、進捗表で管理する
- 公開URLは `https://finaloji.github.io/nandeya-studio/` ＋リポジトリ内パス（例: `apps/roulette/roulette.html`）
- 新しいアプリを追加したら、この表に1行追加し、`apps/<名前>/docs/` に仕様書と進捗表を作ること

## 全マジックアプリ共通ルール

### 難読化（最重要）

マジシャンが使う秘密のツールのため、コードを見てもフォース機能の存在がわからないようにする。

- localStorage キーは意味のない名前にする（`_dcc`, `_tcm`, `_tcv`, `_lfc` など）
- 関数名も同様に難読化する（`dcc()`, `glf()` など）
- UI上のラベルは「表示設定」「数値補正」など、マジックのネタがバレない言葉を使う
- 新機能を追加するときもこの方針を維持すること

### ライセンス認証

- Firebase Firestore を使用（Firebase Auth は不使用）
- 独自のID/パスコード方式。端末は2台までのLRUロック
- 管理画面は `apps/stopwatch/admin.html` に集約する（アプリごとに新規作成しない）

### 技術スタック

- 純粋なHTML/CSS/JavaScript（フレームワーク不使用）。各アプリは単一HTMLを本体とし、必要に応じて manifest.json / sw.js / icons を追加
- モバイルファーストのレスポンシブデザイン、PWA対応（manifest.json、apple-touch-icon）
- ホスティングは GitHub Pages。公式サイトはWix（WordPress不使用）

### 既知の技術的注意点

- `type="module"` スクリプトはDOMより後に実行されるため、Firebase の初期化タイミングに注意。`_fsready` カスタムイベントで同期している
- iOSのnumeric inputはEnterキーが発火しないため、決定ボタンを明示的に設置すること
- GitHub Pages のデプロイは時々失敗する。push後にcurlで配信を確認し、反映されない場合は再pushで復旧する

## 開発フロー

- 実装は `/sprint`（Planner → Generator → 人間レビュー）で進める。詳細は `docs/dev-workflow.md` を参照
- コード変更後は確認を待たず即コミット＆push（スマホ実機確認のため常に最新を保つ）
- マジックアプリの構想・壁打ちは `/magic-kabeuchi` で進める（ワークフロー順のヒアリングで仕様書ドラフトを作る。トークン節約のためファイル読み込みは最小限）
