# WiFi予言ギミック 進捗表

仕様書: `wifi-prediction-spec.md`

環境構築（0-x）は本人の実機操作が必須のため、Planner/Generatorの自動ハーネスは使わず、Claude Codeとの一工程ずつの対話で進める。Phase1以降のファームウェア/Web UIコードは通常の `/sprint` ハーネス（Planner→Generator→人間レビュー）で進める。

| グループ | # | 作業内容 | 状態 |
|---------|---|---------|------|
| 環境構築 | 0-1 | PC側ソフト準備・Arduino IDEインストール | 未着手 |
| 環境構築 | 0-2 | ESP32 Board Manager設定・ボード選定 | 未着手 |
| 環境構築 | 0-3 | USB接続・COMポート確認・最初の書き込みテスト | 未着手 |
| Phase1 単一SSID | 1-1 | NANDEYA_TEST をSoftApで発信・iPhoneで確認 | 未着手 |
| Phase2 WebUI | 2-1 | ESP32内ローカルWebサーバーの最小表示 | 未着手 |
| Phase2 WebUI | 2-2 | 予言文入力フォーム→ESP32へ送信（SEND） | 未着手 |
| Phase2 WebUI | 2-3 | STOPボタンでSoftAP停止 | 未着手 |
| Phase3 複数SSID | 3-1 | 固定文言を3個のSSIDに分割発信するテスト | 未着手 |
| Phase3 複数SSID | 3-2 | 5→10→20個への段階的拡張・表示/消失時間計測 | 未着手 |
| Phase3 複数SSID | 3-3 | iPhone/Android挙動比較・安定数の見極め | 未着手 |
| Phase4 本番UI | 4-1 | プリセット機能（人物/数字/トランプ/国/誕生日/自由入力） | 未着手 |
| Phase4 本番UI | 4-2 | REVEAL/STOPボタンと状態表示(READY/REVEALING/STOPPED) | 未着手 |
| Phase4 本番UI | 4-3 | マジシャン向け最終デザイン（ダーク・大ボタン・片手操作） | 未着手 |

## 次に着手するスプリント
0-1: PC側ソフト準備・Arduino IDEインストール
