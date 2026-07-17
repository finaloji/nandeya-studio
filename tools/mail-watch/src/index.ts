/**
 * mail-watch: 代表宛メール見落とし防止AI秘書（Cloudflare Workers）
 *
 * エントリポイント。
 * - HTTP: 稼働確認レスポンスに加え、Gmail連携の動作確認用エンドポイント（GET /debug/gmail-check）を提供する
 *   （除外フィルタを通過したメールはD1のemailsテーブルへ保存し、新規保存された分のみGeminiでAI整理してUPDATEする）
 * - Cron: どのCronが発火したかログ出力するのみ（Gmail連携呼び出し・AI整理・LINE通知の自動組み込みはまだ行わない）
 */

import { GmailApiError, fetchAccessToken, fetchMessageDetails, filterExcludedSenders, searchMessageIds } from "./gmail";
import type { GmailMessageDetail } from "./gmail";
import { saveEmails, updateEmailAiFields } from "./db";
import { GEMINI_CALL_INTERVAL_MS, GeminiApiError, classifyEmail } from "./gemini";

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
 * 動作確認用: access token取得 → Gmail検索 → 各メール詳細取得 → 除外フィルタ → D1保存、を一連で実行し結果を返す。
 * AI要約・LINE通知は行わない（スコープ外）。開発者が手動でアクセスして確認する想定。
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
    const { passed, excluded } = filterExcludedSenders(details);

    // 除外フィルタを通過したメールのみD1のemailsテーブルへ保存する。0件の場合は保存処理自体を行わない
    const saveSummary =
      passed.length > 0
        ? await saveEmails(env.DB, passed)
        : { insertedCount: 0, duplicateCount: 0, failedCount: 0, results: [] };

    // D1へ新規保存された（outcome: "inserted"）メールのみをAI整理の対象とする。
    // 重複スキップ・保存失敗の行は対象外。
    const insertedGmailIds = new Set(
      saveSummary.results.filter((r) => r.outcome === "inserted").map((r) => r.gmailId)
    );
    const insertedEmails = passed.filter((d) => insertedGmailIds.has(d.id));
    const aiOrganizeResults = await organizeEmailsWithAi(env, insertedEmails);

    return Response.json({
      status: "ok",
      count: passed.length,
      messages: passed.map((d) => ({
        id: d.id,
        threadId: d.threadId,
        subject: d.subject,
        from: d.from,
        receivedAt: d.receivedAt,
        bodyPreview: d.body.slice(0, 200),
        bodyLength: d.body.length,
      })),
      excludedCount: excluded.length,
      excludedMessages: excluded.map(({ message, reason }) => ({
        id: message.id,
        threadId: message.threadId,
        subject: message.subject,
        from: message.from,
        reason,
      })),
      dbSave: {
        insertedCount: saveSummary.insertedCount,
        duplicateCount: saveSummary.duplicateCount,
        failedCount: saveSummary.failedCount,
        results: saveSummary.results,
      },
      aiOrganize: {
        targetCount: insertedEmails.length,
        succeededCount: aiOrganizeResults.filter((r) => r.outcome === "succeeded").length,
        failedCount: aiOrganizeResults.filter((r) => r.outcome === "failed").length,
        results: aiOrganizeResults,
      },
    });
  } catch (error) {
    return gmailCheckErrorResponse(error, "detail");
  }
}

/** 1件のAI整理を試みた結果 */
interface AiOrganizeResult {
  /** GmailメッセージID */
  gmailId: string;
  /** "succeeded": Gemini呼び出し・D1 UPDATEとも成功 / "failed": いずれかの段階で失敗 */
  outcome: "succeeded" | "failed";
  /** outcomeが"failed"の場合、どの段階で失敗したか（呼び出し自体 / JSONパース / DB更新） */
  stage?: "call" | "parse" | "db";
  /** outcomeが"failed"の場合のエラーメッセージ */
  errorMessage?: string;
}

/**
 * D1へ新規保存されたメールについて、1件ずつGemini APIでAI整理（summary/deadline/urgency/target）を行い、
 * emails行へUPDATEする。Gemini呼び出しは並列実行せず、GEMINI_CALL_INTERVAL_MSの間隔を空けて逐次実行する。
 * 対象が0件の場合はGemini APIを一切呼び出さない。
 * 1件の失敗（呼び出し失敗・パース失敗・DB更新失敗）が他のメールの処理を止めることはない。
 */
async function organizeEmailsWithAi(env: Env, emails: GmailMessageDetail[]): Promise<AiOrganizeResult[]> {
  const results: AiOrganizeResult[] = [];

  for (let i = 0; i < emails.length; i++) {
    if (i > 0) {
      await sleep(GEMINI_CALL_INTERVAL_MS);
    }

    const email = emails[i];

    try {
      const fields = await classifyEmail(env.GEMINI_API_KEY, email);

      try {
        await updateEmailAiFields(env.DB, email.id, fields);
        results.push({ gmailId: email.id, outcome: "succeeded" });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[mail-watch] AI整理結果のD1反映に失敗しました (gmail_id=${email.id}): ${errorMessage}`);
        results.push({ gmailId: email.id, outcome: "failed", stage: "db", errorMessage });
      }
    } catch (error) {
      if (error instanceof GeminiApiError) {
        console.error(`[mail-watch] Gemini連携エラー (stage=${error.stage}, gmail_id=${email.id}): ${error.message}`);
        results.push({ gmailId: email.id, outcome: "failed", stage: error.stage, errorMessage: error.message });
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[mail-watch] AI整理で想定外のエラー (gmail_id=${email.id}): ${errorMessage}`);
        results.push({ gmailId: email.id, outcome: "failed", stage: "call", errorMessage });
      }
    }
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
