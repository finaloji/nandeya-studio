// Gmail APIのrefresh tokenを取得する使い捨てスクリプト。
// 実行方法: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を環境変数で渡して実行する。
//   node scripts/get-refresh-token.mjs
// ブラウザでの認可完了後、コンソールに refresh_token が表示される。

import http from "node:http";
import { URL } from "node:url";

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を環境変数で渡してください。");
  process.exit(1);
}

const scope = "https://www.googleapis.com/auth/gmail.readonly";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname !== "/") return;

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("認可コードがありません。");
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h1>認可が完了しました。このタブは閉じて構いません。</h1>");

  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenJson = await tokenRes.json();

  if (!tokenRes.ok) {
    console.error("トークン取得に失敗しました:", tokenJson);
    server.close();
    process.exit(1);
  }

  console.log("\n=== 取得結果 ===");
  console.log("refresh_token:", tokenJson.refresh_token);
  console.log("================\n");

  if (!tokenJson.refresh_token) {
    console.warn(
      "refresh_token が返ってきませんでした。既に一度このアプリを認可したことがある場合に起こります。" +
        "Googleアカウントの「サードパーティ製アプリとサービス」で mail-watch-client のアクセスを一度取り消してから、再実行してください。"
    );
  }

  server.close();
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log("\n以下のURLをブラウザで開いて、nandeya.haken@gmail.com で認可してください:\n");
  console.log(authUrl.toString());
  console.log("\n認可が完了するまで待機しています...\n");
});
