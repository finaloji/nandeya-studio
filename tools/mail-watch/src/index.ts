/**
 * mail-watch: 代表宛メール見落とし防止AI秘書（Cloudflare Workers）
 *
 * スプリント1-1時点の暫定エントリポイント。
 * - HTTP: 稼働確認レスポンスを返すのみ
 * - Cron: どのCronが発火したかログ出力するのみ（DB書き込みなし）
 */

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

export default {
  /** HTTP アクセス時: 稼働確認用の簡素な応答を返す */
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
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
