/**
 * mail-watch: 代表宛メール見落とし防止AI秘書（Cloudflare Workers）
 *
 * エントリポイント。
 * - HTTP: 稼働確認レスポンスに加え、以下のエンドポイントを提供する
 *   - GET /            : 管理画面（一覧表示）。パスコード認証は未実装（後日追加予定）
 *   - GET /debug/gmail-check : Gmail連携の動作確認用エンドポイント（開発者向け）
 *     （除外フィルタを通過したメールはD1のemailsテーブルへ保存し、新規保存された分のみGeminiでAI整理してUPDATEする）
 * - Cron: どのCronが発火したかログ出力するのみ（Gmail連携呼び出し・AI整理・LINE通知の自動組み込みはまだ行わない）
 */

import {
  DETAIL_FETCH_INTERVAL_MS,
  GmailApiError,
  fetchAccessToken,
  fetchMessageDetails,
  fetchThreadMessages,
  filterExcludedSenders,
  searchMessageIds,
} from "./gmail";
import type { GmailMessageDetail, GmailThreadMessage } from "./gmail";
import {
  EMAIL_STATUSES,
  getDashboardData,
  getReplyCheckTargetEmails,
  markEmailAsReplied,
  recordNotifications,
  saveEmails,
  updateEmailAiFields,
  updateEmailStatus,
} from "./db";
import type { EmailStatus, ReplyCheckTargetEmail, UpdatableEmailStatus } from "./db";
import { GEMINI_CALL_INTERVAL_MS, GeminiApiError, classifyEmail } from "./gemini";
import type { EmailAiFields } from "./gemini";
import { decideNotifications } from "./notification";
import type { NotificationCandidate, NotificationDecisionResult } from "./notification";
import { LINE_CALL_INTERVAL_MS, LineApiError, pushLineNotification, pushMorningDigestNotification } from "./line";
import type { MorningDigestItem } from "./line";
import { renderDashboardHtml } from "./dashboard";

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
 * 朝のまとめ通知で「管理画面を開く」ボタンのリンク先に使うベースURL。
 * Cron実行時（scheduledハンドラ）はHTTPリクエストが存在しないため、この固定値を使う。
 * TODO: 本番デプロイ後、実際のWorkers公開URL（*.workers.dev）へ更新すること。
 */
const MORNING_DIGEST_DASHBOARD_BASE_URL = "https://mail-watch.example.workers.dev";

/**
 * 動作確認用: access token取得 → Gmail検索 → 各メール詳細取得 → 除外フィルタ → D1保存 →
 * AI整理 → 通知要否判定 → LINE通知送信、を一連で実行し結果を返す。開発者が手動でアクセスして確認する想定。
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

    // AI整理が成功したメールのみを通知要否判定の対象とする（失敗したメールは判定対象外）。
    // AI整理全体（対象メール全件のループ）が完了した後、まとめて1回で判定する。
    const notificationCandidates: NotificationCandidate[] = aiOrganizeResults
      .filter((r) => r.outcome === "succeeded")
      .map((r) => ({ gmailId: r.gmailId, target: r.target ?? null, urgency: r.urgency ?? null }));
    const notificationDecisionSummary = decideNotifications(notificationCandidates);

    // 通知要否判定でshouldNotify: trueとなったメールについて、1件ずつLINEへpush送信する。
    // 件名・送信者・スレッドIDはinsertedEmails（GmailMessageDetail）、要約・期限はaiOrganizeResultsから
    // gmailIdをキーに突き合わせて使う（同一リクエスト内のメモリ上データのみで完結させ、D1へは問い合わせない）。
    const emailsById = new Map(insertedEmails.map((e) => [e.id, e]));
    const aiFieldsById = new Map(
      aiOrganizeResults
        .filter((r) => r.outcome === "succeeded")
        .map((r) => [r.gmailId, { summary: r.summary ?? null, deadline: r.deadline ?? null }])
    );
    const lineNotifySummary = await sendLineNotifications(
      env,
      notificationDecisionSummary.results,
      emailsById,
      aiFieldsById
    );

    // LINE送信に成功したメールのみを対象に、action_logsへの記録とemailsのnotify_count更新を行う。
    // 送信フェーズ（sendLineNotifications）が全件完了した後にまとめて記録する（フェーズを分離する）。
    // 対象が0件の場合はrecordNotifications自体を呼び出さない（D1へのクエリを発生させない）。
    const notifiedGmailIds = lineNotifySummary.results
      .filter((r) => r.outcome === "succeeded")
      .map((r) => r.gmailId);
    const notifyRecordSummary =
      notifiedGmailIds.length > 0
        ? await recordNotifications(env.DB, notifiedGmailIds)
        : { targetCount: 0, succeededCount: 0, failedCount: 0, results: [] };

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
      notificationDecision: {
        targetCount: notificationDecisionSummary.targetCount,
        shouldNotifyCount: notificationDecisionSummary.shouldNotifyCount,
        skipCount: notificationDecisionSummary.skipCount,
        results: notificationDecisionSummary.results,
      },
      lineNotify: {
        targetCount: lineNotifySummary.targetCount,
        succeededCount: lineNotifySummary.succeededCount,
        failedCount: lineNotifySummary.failedCount,
        results: lineNotifySummary.results,
      },
      notifyRecord: {
        targetCount: notifyRecordSummary.targetCount,
        succeededCount: notifyRecordSummary.succeededCount,
        failedCount: notifyRecordSummary.failedCount,
        results: notifyRecordSummary.results,
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
  /** outcomeが"succeeded"の場合のGeminiによる緊急度判定（通知要否判定に使う） */
  urgency?: EmailAiFields["urgency"];
  /** outcomeが"succeeded"の場合のGeminiによる宛先分類（通知要否判定に使う） */
  target?: EmailAiFields["target"];
  /** outcomeが"succeeded"の場合のGeminiによる要約（LINE通知に使う） */
  summary?: EmailAiFields["summary"];
  /** outcomeが"succeeded"の場合のGeminiによる期限判定（LINE通知に使う） */
  deadline?: EmailAiFields["deadline"];
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
        results.push({
          gmailId: email.id,
          outcome: "succeeded",
          urgency: fields.urgency,
          target: fields.target,
          summary: fields.summary,
          deadline: fields.deadline,
        });
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

/** 1件のLINE通知送信を試みた結果 */
interface LineNotifyResult {
  /** GmailメッセージID */
  gmailId: string;
  /** "succeeded": LINE APIへのpushが成功 / "failed": 失敗 */
  outcome: "succeeded" | "failed";
  /** outcomeが"failed"の場合のエラーメッセージ（LINE APIから返ってきたエラー内容を含む） */
  errorMessage?: string;
}

/** 複数件のLINE通知送信結果をまとめたサマリ */
interface LineNotifySummary {
  /** 送信対象件数（shouldNotify: trueだった件数） */
  targetCount: number;
  /** 送信成功件数 */
  succeededCount: number;
  /** 送信失敗件数 */
  failedCount: number;
  /** メールごとの送信結果一覧 */
  results: LineNotifyResult[];
}

/**
 * 通知要否判定でshouldNotify: trueとなったメールについて、1件ずつLINE Messaging APIへpush送信する。
 * LINE API呼び出しは並列実行せず、LINE_CALL_INTERVAL_MSの間隔を空けて逐次実行する。
 * 対象が0件の場合はLINE APIを一切呼び出さない。
 * 1件の送信失敗（呼び出し失敗・レート制限含む）が他のメールへの送信を止めることはない。
 */
async function sendLineNotifications(
  env: Env,
  decisions: NotificationDecisionResult[],
  emailsById: Map<string, GmailMessageDetail>,
  aiFieldsById: Map<string, { summary: EmailAiFields["summary"]; deadline: EmailAiFields["deadline"] }>
): Promise<LineNotifySummary> {
  const targets = decisions.filter((d) => d.shouldNotify);
  const results: LineNotifyResult[] = [];

  for (let i = 0; i < targets.length; i++) {
    if (i > 0) {
      await sleep(LINE_CALL_INTERVAL_MS);
    }

    const decision = targets[i];
    const email = emailsById.get(decision.gmailId);
    const aiFields = aiFieldsById.get(decision.gmailId);

    if (!email) {
      // 通知要否判定の対象はinsertedEmailsから作られたaiOrganizeResults由来のため、通常は起こり得ない
      const errorMessage = `対象メールの詳細情報（件名・送信者・スレッドID）が見つかりませんでした (gmail_id=${decision.gmailId})`;
      console.error(`[mail-watch] LINE通知エラー: ${errorMessage}`);
      results.push({ gmailId: decision.gmailId, outcome: "failed", errorMessage });
      continue;
    }

    try {
      await pushLineNotification(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_TARGET_USER_ID, {
        subject: email.subject,
        from: email.from,
        threadId: email.threadId,
        summary: aiFields?.summary ?? null,
        deadline: aiFields?.deadline ?? null,
        urgency: decision.urgency,
      });
      results.push({ gmailId: decision.gmailId, outcome: "succeeded" });
    } catch (error) {
      if (error instanceof LineApiError) {
        console.error(`[mail-watch] LINE通知エラー (gmail_id=${decision.gmailId}): ${error.message}`);
        results.push({ gmailId: decision.gmailId, outcome: "failed", errorMessage: error.message });
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[mail-watch] LINE通知で想定外のエラー (gmail_id=${decision.gmailId}): ${errorMessage}`);
        results.push({ gmailId: decision.gmailId, outcome: "failed", errorMessage });
      }
    }
  }

  return {
    targetCount: targets.length,
    succeededCount: results.filter((r) => r.outcome === "succeeded").length,
    failedCount: results.filter((r) => r.outcome === "failed").length,
    results,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 管理画面（`/`）表示用: D1から4ステータス分のメール一覧・件数を取得し、HTMLを組み立てて返す。
 * パスコード認証は未実装（後日追加予定）。検索エンジン非インデックス化のみ meta robots で対応する。
 * ?tab=<status> クエリパラメータで初期表示タブを指定できる（未指定・不正値の場合は「未確認」タブ）。
 * 既存の「1回のGETで4ステータス分すべて取得」という構造は変えない。
 */
async function handleDashboard(env: Env, url: URL): Promise<Response> {
  const data = await getDashboardData(env.DB);
  const initialStatus = parseInitialTabStatus(url);
  const html = renderDashboardHtml(data, initialStatus);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** `/`のクエリパラメータ`tab`から初期表示タブのステータスを取り出す。不正・未指定の場合は"unread"にフォールバックする */
function parseInitialTabStatus(url: URL): EmailStatus {
  const tab = url.searchParams.get("tab");
  if (tab !== null && (EMAIL_STATUSES as readonly string[]).includes(tab)) {
    return tab as EmailStatus;
  }
  return "unread";
}

/** ステータス更新API（PUT /emails/{gmail_id}/status）のリクエストボディに指定できる遷移先ステータス */
const UPDATABLE_STATUSES: readonly UpdatableEmailStatus[] = ["acknowledged", "in_progress", "done"];

/**
 * PUT /emails/{gmail_id}/status : 対象メールのステータスを更新し、action_logsへ実際の遷移先1行を記録する。
 * リクエストボディ { status: "acknowledged" | "in_progress" | "done" } を受け取る（サーバー側で次状態を自動計算しない）。
 * 結果種別（updated/already_at_or_past/not_found/failed）と更新後のステータスをレスポンスで返す。
 */
async function handleUpdateEmailStatus(env: Env, gmailId: string, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (error) {
    return Response.json(
      { status: "error", outcome: "invalid_request", message: "リクエストボディがJSONとして解釈できません" },
      { status: 400 }
    );
  }

  const targetStatus = (body as { status?: unknown } | null)?.status;
  if (typeof targetStatus !== "string" || !UPDATABLE_STATUSES.includes(targetStatus as UpdatableEmailStatus)) {
    return Response.json(
      {
        status: "error",
        outcome: "invalid_request",
        message: "statusはacknowledged/in_progress/doneのいずれかを指定してください",
      },
      { status: 400 }
    );
  }

  const result = await updateEmailStatus(env.DB, gmailId, targetStatus as UpdatableEmailStatus);

  switch (result.outcome) {
    case "updated":
      return Response.json({ status: "ok", outcome: "updated", currentStatus: result.status });
    case "already_at_or_past":
      return Response.json({
        status: "ok",
        outcome: "already_at_or_past",
        currentStatus: result.status,
        message: "既にそのステータス（またはそれ以降）です",
      });
    case "not_found":
      return Response.json(
        { status: "error", outcome: "not_found", currentStatus: null, message: "対象のメールが見つかりませんでした" },
        { status: 404 }
      );
    case "failed":
    default:
      return Response.json(
        { status: "error", outcome: "failed", currentStatus: result.status, message: "更新に失敗しました" },
        { status: 500 }
      );
  }
}

/** 1件の返信判定を試みた結果 */
interface ReplyCheckResult {
  /** GmailメッセージID */
  gmailId: string;
  /** スレッドID */
  threadId: string;
  /** 件名（動作確認レスポンスの見やすさのために含める） */
  subject: string;
  /** "replied": 返信を検出した / "not_replied": 返信は検出されなかった / "failed": 判定処理自体が失敗した（未返信と誤判定しない） */
  outcome: "replied" | "not_replied" | "failed";
  /** outcomeが"replied"の場合、根拠となったSENTメッセージの日時（最も古いもの） */
  repliedAt?: string;
  /** outcomeが"failed"の場合のエラーメッセージ */
  errorMessage?: string;
  /** outcomeが"replied"の場合のステータス更新結果（markEmailAsRepliedの結果） */
  statusUpdate?: { outcome: MarkEmailAsRepliedOutcome; status: string | null };
}

/** markEmailAsRepliedのoutcome型（db.tsのUpdateEmailStatusOutcomeと同一だがここでは表示用に文字列として扱う） */
type MarkEmailAsRepliedOutcome = "updated" | "already_at_or_past" | "not_found" | "failed";

/**
 * status <> 'done' の対象メール1件について、スレッド内のSENTメッセージを確認し、
 * 受信日時より後のSENTメッセージが1件でもあれば返信済みと判定し、markEmailAsRepliedでstatusをdoneへ進める。
 * スレッド取得に失敗した場合は「判定失敗」とし、未返信と誤判定しない（ステータス更新・action_logs記録は行わない）。
 */
async function checkReplyForEmail(env: Env, accessToken: string, target: ReplyCheckTargetEmail): Promise<ReplyCheckResult> {
  let threadMessages: GmailThreadMessage[];
  try {
    threadMessages = await fetchThreadMessages(accessToken, target.threadId);
  } catch (error) {
    const errorMessage =
      error instanceof GmailApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    console.error(`[mail-watch] 返信判定でスレッド取得に失敗しました (gmail_id=${target.gmailId}, thread_id=${target.threadId}): ${errorMessage}`);
    return { gmailId: target.gmailId, threadId: target.threadId, subject: target.subject, outcome: "failed", errorMessage };
  }

  // ラベルにSENTを含み、かつ受信日時より後のメッセージを、日時の古い順に探す
  const sentAfterReceived = threadMessages
    .filter((m) => m.labelIds.includes("SENT") && new Date(m.internalDate).getTime() > new Date(target.receivedAt).getTime())
    .sort((a, b) => new Date(a.internalDate).getTime() - new Date(b.internalDate).getTime());

  if (sentAfterReceived.length === 0) {
    return { gmailId: target.gmailId, threadId: target.threadId, subject: target.subject, outcome: "not_replied" };
  }

  const repliedAt = sentAfterReceived[0].internalDate;

  try {
    const updateResult = await markEmailAsReplied(env.DB, target.gmailId);
    return {
      gmailId: target.gmailId,
      threadId: target.threadId,
      subject: target.subject,
      outcome: "replied",
      repliedAt,
      statusUpdate: { outcome: updateResult.outcome, status: updateResult.status },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[mail-watch] 返信検出後のステータス更新で想定外のエラー (gmail_id=${target.gmailId}): ${errorMessage}`);
    return {
      gmailId: target.gmailId,
      threadId: target.threadId,
      subject: target.subject,
      outcome: "replied",
      repliedAt,
      statusUpdate: { outcome: "failed", status: null },
    };
  }
}

/** 返信済み判定を対象メール全件に対して実行した結果のサマリ */
interface ReplyCheckRunSummary {
  /** 返信を検出した件数 */
  repliedCount: number;
  /** 返信を検出しなかった件数 */
  notRepliedCount: number;
  /** 判定自体に失敗した件数（未返信と誤判定しないため、対象からは除外しない） */
  failedCount: number;
  /** 返信検出によりstatusが自動でdoneに更新された件数 */
  autoCompletedCount: number;
}

/** 返信済み判定を対象メール全件に対して実行した結果 */
interface ReplyCheckRunResult {
  /** 判定対象件数 */
  targetCount: number;
  /** メールごとの判定結果一覧 */
  results: ReplyCheckResult[];
  summary: ReplyCheckRunSummary;
}

/**
 * 判定対象（targets）について、Gmailスレッドを確認して返信検出を行い、
 * 返信を検出したメールはstatusをdoneへ自動更新する。access tokenの取得は呼び出し元が行う。
 * 各メールの判定は逐次処理（並列実行しない）し、スレッド取得の間にはDETAIL_FETCH_INTERVAL_MSの間隔を空ける。
 * `/debug/reply-check`（handleReplyCheck）と朝のまとめ通知（runMorningDigest）の両方から共通で使う。
 */
async function runReplyCheck(env: Env, accessToken: string, targets: ReplyCheckTargetEmail[]): Promise<ReplyCheckRunResult> {
  const results: ReplyCheckResult[] = [];
  for (let i = 0; i < targets.length; i++) {
    if (i > 0) {
      await sleep(DETAIL_FETCH_INTERVAL_MS);
    }
    results.push(await checkReplyForEmail(env, accessToken, targets[i]));
  }

  const repliedCount = results.filter((r) => r.outcome === "replied").length;
  const notRepliedCount = results.filter((r) => r.outcome === "not_replied").length;
  const failedCount = results.filter((r) => r.outcome === "failed").length;
  const autoCompletedCount = results.filter((r) => r.outcome === "replied" && r.statusUpdate?.outcome === "updated").length;

  return {
    targetCount: targets.length,
    results,
    summary: { repliedCount, notRepliedCount, failedCount, autoCompletedCount },
  };
}

/**
 * 動作確認用: status <> 'done' の対象メールについて、Gmailスレッドを確認して返信検出を行い、
 * 返信を検出したメールはstatusをdoneへ自動更新する（開発者向けエンドポイント）。
 * 対象0件の場合はGmail APIへの問い合わせ自体を行わない。access token取得の失敗のみ全体を打ち切る。
 * 各メールの判定は逐次処理（並列実行しない）し、スレッド取得の間にはDETAIL_FETCH_INTERVAL_MSの間隔を空ける。
 */
async function handleReplyCheck(env: Env): Promise<Response> {
  const targets = await getReplyCheckTargetEmails(env.DB);

  if (targets.length === 0) {
    return Response.json({
      status: "ok",
      message: "判定対象のメール（status <> 'done'）は0件でした",
      targetCount: 0,
      results: [],
      summary: { repliedCount: 0, notRepliedCount: 0, failedCount: 0, autoCompletedCount: 0 },
    });
  }

  let accessToken: string;
  try {
    accessToken = await fetchAccessToken(env);
  } catch (error) {
    return gmailCheckErrorResponse(error, "token");
  }

  const run = await runReplyCheck(env, accessToken, targets);

  return Response.json({
    status: "ok",
    targetCount: run.targetCount,
    results: run.results,
    summary: run.summary,
  });
}

/** LINE送信の結果（対象0件で送信しなかった場合はattempted: false） */
interface MorningDigestLineSendResult {
  attempted: boolean;
  succeeded?: boolean;
  errorMessage?: string;
}

/** 朝のまとめ通知1回分の実行結果。access token取得に失敗した場合は"aborted"となり、それ以外は最後まで実行される（LINE送信の成否は問わない） */
type MorningDigestRunResult =
  | {
      outcome: "aborted";
      /** 打ち切りの原因となった段階 */
      stage: "token";
      errorMessage: string;
    }
  | {
      outcome: "completed";
      /** 返信済み判定の実行結果 */
      replyCheck: ReplyCheckRunResult;
      /** まとめ通知対象件数（返信済み判定完了後に再取得した、status <> 'done'の件数） */
      digestTargetCount: number;
      /** まとめ通知に含めた項目（件名・送信者一覧。上限適用前の全件） */
      digestItems: MorningDigestItem[];
      lineSend: MorningDigestLineSendResult;
    };

/**
 * 朝のまとめ通知1回分の処理本体。以下の順序を必ず守る。
 * 1. status <> 'done' の対象メール全件に対して返信済み判定を先に実行する（0件ならGmail APIには触れない）。
 * 2. 判定完了後、あらためて status <> 'done' のメールを再取得し、まとめ通知の対象とする。
 * 3. 対象が1件以上あれば1通のLINE Flex Messageにまとめてpushする。0件ならLINE APIは一切呼び出さない。
 * access token取得自体が失敗した場合は、対象抽出・まとめ通知の段階に進まず処理全体を打ち切る。
 * LINE送信の成否と、既に行われた返信済み判定によるstatus更新・action_logs記録は独立して扱う（ロールバックしない）。
 */
async function runMorningDigest(env: Env, dashboardUrl: string): Promise<MorningDigestRunResult> {
  // 1. 返信済み判定（status <> 'done' 全件が対象）
  const replyCheckTargets = await getReplyCheckTargetEmails(env.DB);

  let replyCheck: ReplyCheckRunResult;
  if (replyCheckTargets.length === 0) {
    replyCheck = {
      targetCount: 0,
      results: [],
      summary: { repliedCount: 0, notRepliedCount: 0, failedCount: 0, autoCompletedCount: 0 },
    };
  } else {
    let accessToken: string;
    try {
      accessToken = await fetchAccessToken(env);
    } catch (error) {
      const errorMessage =
        error instanceof GmailApiError ? error.message : error instanceof Error ? error.message : String(error);
      console.error(`[mail-watch] 朝のまとめ通知: access token取得に失敗したため処理全体を打ち切りました: ${errorMessage}`);
      return { outcome: "aborted", stage: "token", errorMessage };
    }

    replyCheck = await runReplyCheck(env, accessToken, replyCheckTargets);
  }

  // 2. 返信済み判定完了後、あらためて対象を再取得する（同じ条件で再クエリする）
  const digestTargets = await getReplyCheckTargetEmails(env.DB);
  const digestItems: MorningDigestItem[] = digestTargets.map((t) => ({ subject: t.subject, from: t.fromAddr }));

  // 3. まとめ通知の送信（対象0件ならLINE APIを一切呼び出さない）
  if (digestItems.length === 0) {
    console.log("[mail-watch] 朝のまとめ通知: 対象0件のため送信スキップ");
    return {
      outcome: "completed",
      replyCheck,
      digestTargetCount: 0,
      digestItems: [],
      lineSend: { attempted: false },
    };
  }

  try {
    await pushMorningDigestNotification(env.LINE_CHANNEL_ACCESS_TOKEN, env.LINE_TARGET_USER_ID, digestItems, dashboardUrl);
    return {
      outcome: "completed",
      replyCheck,
      digestTargetCount: digestItems.length,
      digestItems,
      lineSend: { attempted: true, succeeded: true },
    };
  } catch (error) {
    const errorMessage =
      error instanceof LineApiError ? error.message : error instanceof Error ? error.message : String(error);
    console.error(`[mail-watch] 朝のまとめ通知のLINE送信に失敗しました: ${errorMessage}`);
    return {
      outcome: "completed",
      replyCheck,
      digestTargetCount: digestItems.length,
      digestItems,
      lineSend: { attempted: true, succeeded: false, errorMessage },
    };
  }
}

/**
 * 開発者向けエンドポイント: Cronを待たずに朝のまとめ通知（返信済み判定→対象抽出→まとめ通知）を手動実行する。
 * 管理画面ボタンのリンク先には、このリクエスト自体のoriginを使う（Cron実行時と異なりリクエストが存在するため）。
 */
async function handleMorningDigest(env: Env, url: URL): Promise<Response> {
  const dashboardUrl = `${url.origin}/`;
  const result = await runMorningDigest(env, dashboardUrl);

  if (result.outcome === "aborted") {
    return Response.json(
      {
        status: "error",
        stage: result.stage,
        message: result.errorMessage,
        replyCheck: null,
        digestTargetCount: 0,
        lineSend: { attempted: false },
      },
      { status: 200 }
    );
  }

  return Response.json({
    status: "ok",
    replyCheck: {
      targetCount: result.replyCheck.targetCount,
      summary: result.replyCheck.summary,
    },
    digestTargetCount: result.digestTargetCount,
    digestItems: result.digestItems,
    lineSend: result.lineSend,
  });
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

    if (url.pathname === "/") {
      return await handleDashboard(env, url);
    }

    if (url.pathname === "/debug/gmail-check") {
      return await handleGmailCheck(env);
    }

    if (url.pathname === "/debug/reply-check") {
      return await handleReplyCheck(env);
    }

    if (url.pathname === "/debug/morning-digest") {
      return await handleMorningDigest(env, url);
    }

    const statusUpdateMatch = url.pathname.match(/^\/emails\/([^/]+)\/status$/);
    if (statusUpdateMatch) {
      if (request.method !== "PUT") {
        return Response.json({ status: "error", message: "Method Not Allowed" }, { status: 405 });
      }
      return await handleUpdateEmailStatus(env, decodeURIComponent(statusUpdateMatch[1]), request);
    }

    return Response.json({
      name: "mail-watch",
      status: "ok",
      message: "mail-watch は稼働中です",
    });
  },

  /** Cron（scheduled）実行時: どのCronが発火したかログ出力し、CRON_MORNING_DIGESTには朝のまとめ通知処理を割り当てる */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const firedAt = new Date(event.scheduledTime).toISOString();

    switch (event.cron) {
      case CRON_EVERY_5_MIN:
        // 後続スプリント: Gmail取得 → AI要約 → LINE通知 をここに割り当てる
        console.log(`[mail-watch] 5分毎Cron発火 (cron="${event.cron}", scheduledTime=${firedAt})`);
        break;
      case CRON_MORNING_DIGEST:
        console.log(`[mail-watch] 毎朝8時JST Cron発火 (cron="${event.cron}", scheduledTime=${firedAt})`);
        // 返信済み判定 → 対象抽出 → まとめ通知 の一連処理。Cron実行を待たせないためwaitUntilでラップする
        ctx.waitUntil(
          runMorningDigest(env, `${MORNING_DIGEST_DASHBOARD_BASE_URL}/`).then((result) => {
            if (result.outcome === "aborted") {
              console.error(`[mail-watch] 朝のまとめ通知Cron: 処理を打ち切りました (stage=${result.stage}): ${result.errorMessage}`);
              return;
            }
            console.log(
              `[mail-watch] 朝のまとめ通知Cron完了: replyCheck.targetCount=${result.replyCheck.targetCount}, digestTargetCount=${result.digestTargetCount}, lineSend=${JSON.stringify(result.lineSend)}`
            );
          })
        );
        break;
      default:
        // 想定外のパターンでもエラーにはしない（ログのみ）
        console.log(`[mail-watch] 未知のCron発火 (cron="${event.cron}", scheduledTime=${firedAt})`);
        break;
    }
  },
} satisfies ExportedHandler<Env>;
