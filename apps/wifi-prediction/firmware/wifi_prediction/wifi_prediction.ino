/*
  WiFi予言ギミック - Phase1 (スプリント1-1)
  ESP32-S3を固定SSID「NANDEYA_TEST」のSoftAPとして起動し、
  iPhoneのWiFi一覧に表示されることを確認するための最小スケッチ。

  このスプリントの対象外: Web UI、複数SSID、プリセット、REVEAL/STOP。
*/

#include <WiFi.h>

// SSIDは固定。パスワードは空にしてオープン（鍵なし）ネットワークにする。
// マジック用途のため、観客のWiFi一覧に鍵アイコンが出て警戒されないようにするための意図的な仕様。
const char* AP_SSID = "NANDEYA_TEST";
const char* AP_PASSWORD = NULL;

bool apStarted = false;

void setup() {
  Serial.begin(115200);
  delay(1000); // USB CDCでPC側のシリアルモニタが接続されるまでの待ち時間

  Serial.println("=== WiFi予言ギミック: 起動処理を開始しました ===");

  apStarted = startSoftAP();

  if (apStarted) {
    Serial.println("");
    Serial.println("★★★ SoftAPの起動に成功しました ★★★");
    Serial.print("SSID: ");
    Serial.println(AP_SSID);
    Serial.print("IPアドレス: ");
    Serial.println(WiFi.softAPIP());
    Serial.println("→ これでiPhoneのWiFi一覧を確認してよい");
    Serial.println("================================================");
  } else {
    Serial.println("");
    Serial.println("!!! SoftAPの起動に失敗しました !!!");
    Serial.println("================================================");
  }
}

void loop() {
  if (!apStarted) {
    // 失敗時は見逃し防止のため、画面が流れても気づけるよう繰り返し表示する
    Serial.println("!!! SoftAP起動失敗のため、発信を行っていません !!!");
    delay(2000);
  } else {
    // 成功時は継続的なログ出力は不要。SoftAPはバックグラウンドで維持され続けるため、
    // ここではloop()を回し続けるだけでよい
    delay(1000);
  }
}

// SoftAPとして起動する。成否はWiFi.softAP()の戻り値で判定する
bool startSoftAP() {
  WiFi.mode(WIFI_AP);
  bool result = WiFi.softAP(AP_SSID, AP_PASSWORD);

  // 失敗時の原因切り分け用に、ライブラリの戻り値をそのまま出す
  Serial.print("WiFi.softAP() の戻り値: ");
  Serial.println(result ? "true" : "false");

  return result;
}
