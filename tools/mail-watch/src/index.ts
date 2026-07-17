/**
 * mail-watch: 代表宛メール見落とし防止AI秘書（Cloudflare Workers）
 *
 * スプリント1-2時点のエントリポイント。
 * - HTTP: 稼働確認レスポンスに加え、Gmail連携の動作確認用エンドポイント（GET /debug/gmail-check）を提供する
 * - Cron: どのCronが発火したかログ出力するのみ（DB書き込み・Gmail連携呼び出しはまだ行わない）
 */

import { GmailApiError, fetchAccessToken, fetchMessageDetails, searchMessageIds } from "./gmail";

/** バインディングとシークレットの型定義（値の設定は後続スプリント） */
export interface Env {
  /** D1 データベース */
  DB: D1Database;

  // --- 以下はすべて将来使うシークレット（未設定でも本スプリントの動作には影響しない） ---
  /** Gmail API 用 OAuth クライアントID */
  GOOGLE_CLIENT_ID: string;
  /** Gmail API 用 OAuth クライアントシークレット */
  GOOGLE_CLIENT_SECRET: string;
  /** Gmail API 用リフレッシュトークン */
  GOOGLE_REFRESH_TOKEN: string;
  /** Gemini API キー（AI要約用） */
  GEMINI_API_KEY: string;
  /** LINE Messaging API チャネルアクセストークン */
  LINE_CHANNEL_ACCESS_TOKEN: string;
  /** LINE 通知先ユーザーID */
  LINE_TARGET_USER_ID: string;
  /** 管理画面パスコードのハッシュ */
  ADMIN_PASSCODE_HASH: string;
}

/** Cron 発火パターン（wrangler.jsonc の triggers.crons と一致させること） */
const CRON_EVERY_5_MIN = "*/5 * * * *";
const CRON_MORNING_DIGEST = "0 23 * * *"; // UTC 23:00 = JST 8:00

/**
 * 動作確認用: access token取得 → Gmail検索 → 各メール詳細取得、を一連で実行し結果を返す。
 * D1保存・AI要約・LINE通知は行わない（スコープ外）。開発者が手動でアクセスして確認する想定。
 */
async function handleGmailCheck(env: Env): Promise<Response> {
  let accessToken: string;
  try {
    accessToken = await fetchAccessToken(env);
  } catch (error) {
    return gmailCheckErrorResponse(error, "token");
  }

  let messageIds: string[];
  try {
    messageIds = await searchMessageIds(accessToken);
  } catch (error) {
    return gmailCheckErrorResponse(error, "search");
  }

  if (messageIds.length === 0) {
    return Response.json({
      status: "ok",
      message: "該当するメールは0件でした",
      count: 0,
      messages: [],
    });
  }

  try {
    const details = await fetchMessageDetails(accessToken, messageIds);
    return Response.json({
      status: "ok",
      count: details.length,
      messages: details.map((d) => ({
        id: d.id,
        threadId: d.threadId,
        subject: d.subject,
        from: d.from,
        receivedAt: d.receivedAt,
        bodyPreview: d.body.slice(0, 200),
        bodyLength: d.body.length,
      })),
    });
  } catch (error) {
    return gmailCheckErrorResponse(error, "detail");
  }
}

/** Gmail連携エラーを、どの段階で・何が起きたか分かる形でレスポンスにする */
function gmailCheckErrorResponse(error: unknown, fallbackStage: "token" | "search" | "detail"): Response {
  if (error instanceof GmailApiError) {
    console.error(`[mail-watch] Gmail連携エラー (stage=${error.stage}): ${error.message}`, error.detail);
    return Response.json(
      {
        status: "error",
        stage: error.stage,
        message: error.message,
        rateLimited: error.rateLimited,
        detail: error.detail,
      },
      { status: 200 }
    );
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`[mail-watch] 想定外のエラー (stage=${fallbackStage}): ${message}`);
  return Response.json(
    {
      status: "error",
      stage: fallbackStage,
      message,
    },
    { status: 200 }
  );
}

export default {
  /** HTTP アクセス時: 稼働確認用の応答に加え、Gmail連携の動作確認用エンドポイントを提供する */
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/debug/gmail-check") {
      return await handleGmailCheck(env);
    }

    return Response.json({
      name: "mail-watch",
      status: "ok",
      message: "mail-watch は稼働中です",
    });
  },

  /** Cron（scheduled）実行時: どのCronが発火したかログ出力する */
  async scheduled(event: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    const firedAt = new Date(event.scheduledTime).toISOString();

    switch (event.cron) {
      case CRON_EVERY_5_MIN:
        // 後続スプリント: Gmail取得 → AI要約 → LINE通知 をここに割り当てる
        console.log(`[mail-watch] 5分毎Cron発火 (cron="${event.cron}", scheduledTime=${firedAt})`);
        break;
      case CRON_MORNING_DIGEST:
        // 後続スプリント: 毎朝8時(JST)のダイジェスト通知をここに割り当てる
        console.log(`[mail-watch] 毎朝8時JST Cron発火 (cron="${event.cron}", scheduledTime=${firedAt})`);
        break;
      default:
        // 想定外のパターンでもエラーにはしない（ログのみ）
        console.log(`[mail-watch] 未知のCron発火 (cron="${event.cron}", scheduledTime=${firedAt})`);
        break;
    }
  },
} satisfies ExportedHandler<Env>;
