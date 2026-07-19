/**
 * mail-watch: D1データベース操作ロジック
 *
 * スプリント1-3時点の実装範囲:
 * - 除外フィルタを通過したメール（GmailMessageDetail）をemailsテーブルへ保存する
 * - gmail_idのUNIQUE制約により、既に保存済みのメールは重複としてスキップする
 *
 * このスプリントで追加した範囲:
 * - Geminiで整理したAI項目（summary/deadline/urgency/target）を、gmail_idで特定した行にUPDATEする
 *
 * LINE通知・Cronからの自動呼び出しは対象外（後続スプリント）。
 */

import type { GmailMessageDetail } from "./gmail";
import type { EmailAiFields } from "./gemini";

/** SQLiteのUNIQUE制約違反時にD1が返すエラーメッセージの特徴（sqlite3のメッセージ形式に含まれる文字列） */
const UNIQUE_CONSTRAINT_ERROR_PATTERN = /unique constraint/i;

/** 1件のメール保存を試みた結果 */
export interface SaveEmailResult {
  /** GmailメッセージID */
  gmailId: string;
  /** "inserted": 新規保存された / "duplicate": 既にgmail_idが存在したためスキップされた / "failed": 書き込みエラーで保存できなかった */
  outcome: "inserted" | "duplicate" | "failed";
  /** outcomeが"failed"の場合のエラー内容 */
  errorMessage?: string;
}

/** 複数件のメール保存結果をまとめたサマリ */
export interface SaveEmailsSummary {
  /** 新規保存件数 */
  insertedCount: number;
  /** 重複スキップ件数 */
  duplicateCount: number;
  /** 保存失敗件数 */
  failedCount: number;
  /** メールごとの結果一覧 */
  results: SaveEmailResult[];
}

/**
 * 除外フィルタを通過したメールの一覧を、D1のemailsテーブルへ1件ずつ保存する。
 * gmail_idが既に存在する場合はUNIQUE制約違反となるため、そのメールは重複としてスキップ扱いにし、
 * 他のメールの保存処理は継続する。UNIQUE制約違反以外の書き込みエラーが起きた場合も同様に、
 * そのメール1件は失敗として扱い、他の保存処理は継続する。
 * 逐次処理のみ（並列実行しない）。
 */
export async function saveEmails(db: D1Database, emails: GmailMessageDetail[]): Promise<SaveEmailsSummary> {
  const results: SaveEmailResult[] = [];
  let insertedCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;

  for (const email of emails) {
    try {
      await insertEmail(db, email);
      insertedCount++;
      results.push({ gmailId: email.id, outcome: "inserted" });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        duplicateCount++;
        results.push({ gmailId: email.id, outcome: "duplicate" });
        console.log(`[mail-watch] 既にD1に保存済みのためスキップ (gmail_id=${email.id})`);
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        failedCount++;
        results.push({ gmailId: email.id, outcome: "failed", errorMessage });
        console.error(`[mail-watch] D1保存に失敗しました (gmail_id=${email.id}): ${errorMessage}`);
      }
    }
  }

  return { insertedCount, duplicateCount, failedCount, results };
}

/**
 * 1件のメールをemailsテーブルへINSERTする。
 * status/notify_count/created_atはテーブル側のデフォルト値に任せ、
 * summary/deadline/urgency/target/last_notified_atはNULLのまま（後続スプリントで埋める）。
 */
async function insertEmail(db: D1Database, email: GmailMessageDetail): Promise<void> {
  await db
    .prepare(
      `INSERT INTO emails (gmail_id, thread_id, subject, from_addr, received_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(email.id, email.threadId, email.subject, email.from, email.receivedAt)
    .run();
}

/** D1（SQLite）のエラーが、UNIQUE制約違反によるものか判定する */
function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return UNIQUE_CONSTRAINT_ERROR_PATTERN.test(message);
}

/**
 * Geminiで整理したAI項目（EmailAiFields）を、gmail_idで一意に特定したemails行へUPDATEする。
 * summary/deadline/urgency/targetのうちnullの項目は、そのままNULLとしてD1に反映する
 * （代替文言・デフォルト値は補わない）。
 */
export async function updateEmailAiFields(db: D1Database, gmailId: string, fields: EmailAiFields): Promise<void> {
  await db
    .prepare(
      `UPDATE emails
       SET summary = ?, deadline = ?, urgency = ?, target = ?
       WHERE gmail_id = ?`
    )
    .bind(fields.summary, fields.deadline, fields.urgency, fields.target, gmailId)
    .run();
}

/** 1件のLINE通知結果記録を試みた結果 */
export interface NotifyRecordResult {
  /** GmailメッセージID */
  gmailId: string;
  /** "recorded": action_logsへの記録・emailsの更新とも成功 / "failed": いずれかの段階で失敗 */
  outcome: "recorded" | "failed";
  /** outcomeが"failed"の場合のエラー内容 */
  errorMessage?: string;
}

/** 複数件のLINE通知結果記録をまとめたサマリ */
export interface NotifyRecordSummary {
  /** 記録対象件数 */
  targetCount: number;
  /** 記録成功件数 */
  succeededCount: number;
  /** 記録失敗件数 */
  failedCount: number;
  /** メールごとの記録結果一覧 */
  results: NotifyRecordResult[];
}

/**
 * LINE送信に成功したメール（gmail_idの一覧）について、action_logsへ"notified"の記録を追加し、
 * emailsテーブルのnotify_countを+1・last_notified_atを現在時刻で更新する。
 * gmail_id → emailsの内部id の引き当ては、対象のgmail_idをまとめて1回のIN句クエリで行う。
 * 1件ごとのaction_logs INSERTとemails UPDATEはdb.batch()でアトミックに実行し、
 * どちらか一方だけ成功する部分的な不整合が起きないようにする。
 * 1件の失敗（引き当て失敗・batch失敗）が他のメールの記録処理を止めることはない。
 * 対象が0件の場合はD1へのクエリを一切発生させない。
 */
export async function recordNotifications(db: D1Database, gmailIds: string[]): Promise<NotifyRecordSummary> {
  if (gmailIds.length === 0) {
    return { targetCount: 0, succeededCount: 0, failedCount: 0, results: [] };
  }

  const results: NotifyRecordResult[] = [];
  let succeededCount = 0;
  let failedCount = 0;

  // gmail_id → emailsの内部id を1回のIN句クエリでまとめて引き当てる
  let idByGmailId: Map<string, number>;
  try {
    idByGmailId = await lookupEmailIdsByGmailIds(db, gmailIds);
  } catch (error) {
    // 引き当てクエリ自体が失敗した場合は、対象全件を失敗として扱う
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[mail-watch] gmail_id → emails内部idの引き当てに失敗しました: ${errorMessage}`);
    for (const gmailId of gmailIds) {
      results.push({ gmailId, outcome: "failed", errorMessage });
    }
    return { targetCount: gmailIds.length, succeededCount: 0, failedCount: gmailIds.length, results };
  }

  for (const gmailId of gmailIds) {
    const emailId = idByGmailId.get(gmailId);

    if (emailId === undefined) {
      // 通常起こり得ない（emails行がgmail_idで見つからない）
      const errorMessage = `対象のメールがemailsテーブルに見つかりませんでした (gmail_id=${gmailId})`;
      console.error(`[mail-watch] 通知記録エラー: ${errorMessage}`);
      failedCount++;
      results.push({ gmailId, outcome: "failed", errorMessage });
      continue;
    }

    try {
      await db.batch([
        db.prepare(`INSERT INTO action_logs (email_id, action) VALUES (?, 'notified')`).bind(emailId),
        db
          .prepare(`UPDATE emails SET notify_count = notify_count + 1, last_notified_at = datetime('now') WHERE id = ?`)
          .bind(emailId),
      ]);
      succeededCount++;
      results.push({ gmailId, outcome: "recorded" });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[mail-watch] 通知記録の書き込みに失敗しました (gmail_id=${gmailId}): ${errorMessage}`);
      failedCount++;
      results.push({ gmailId, outcome: "failed", errorMessage });
    }
  }

  return { targetCount: gmailIds.length, succeededCount, failedCount, results };
}

/** emailsテーブルのstatusカラムが取りうる値（D1のCHECK制約と一致させること） */
export const EMAIL_STATUSES = ["unread", "acknowledged", "in_progress", "done"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** action_logsテーブルのactionカラムが取りうる値（D1のCHECK制約と一致させること） */
export type ActionLogAction = "notified" | "digest_notified" | "replied" | "acknowledged" | "in_progress" | "done";

/** 管理画面カードの履歴欄に表示する1件分のaction_logs行 */
export interface DashboardActionLog {
  action: ActionLogAction;
  createdAt: string;
}

/** 管理画面一覧に表示する1件分のメール情報 */
export interface DashboardEmailRow {
  /** ステータス更新API呼び出し時にメールを識別するためのGmailメッセージID */
  gmailId: string;
  threadId: string;
  subject: string;
  fromAddr: string;
  receivedAt: string;
  summary: string | null;
  deadline: string | null;
  urgency: "high" | "mid" | "low" | null;
  target: "rep" | "staff" | "other" | null;
  status: EmailStatus;
  /** このメールに紐づくaction_logsの直近10件（新しい順） */
  actionLogs: DashboardActionLog[];
}

/** 管理画面一覧: ステータスごとのメール一覧と件数をまとめたもの */
export interface DashboardData {
  /** ステータスごとのメール一覧（受信日時の新しい順） */
  emailsByStatus: Record<EmailStatus, DashboardEmailRow[]>;
  /** ステータスごとの件数 */
  countsByStatus: Record<EmailStatus, number>;
}

/**
 * 管理画面一覧の表示に必要なデータを、4ステータス分まとめてD1から取得する。
 * 表示のたびに都度クエリを実行する（キャッシュしない）。
 * 各ステータスの一覧は受信日時（received_at）の新しい順で取得する。
 * 各メールに紐づくaction_logsの直近10件も、カードごとの追加リクエストを発生させず
 * まとめて1回のクエリで取得する。
 */
export async function getDashboardData(db: D1Database): Promise<DashboardData> {
  const emailsByStatus = {} as Record<EmailStatus, DashboardEmailRow[]>;
  const countsByStatus = {} as Record<EmailStatus, number>;

  // action_logsをまとめて引き当てるための、emailsの内部id → DashboardEmailRow の対応
  const rowByInternalId = new Map<number, DashboardEmailRow>();

  for (const status of EMAIL_STATUSES) {
    const { results } = await db
      .prepare(
        `SELECT id, gmail_id, thread_id, subject, from_addr, received_at, summary, deadline, urgency, target, status
         FROM emails WHERE status = ? ORDER BY received_at DESC`
      )
      .bind(status)
      .all<{
        id: number;
        gmail_id: string;
        thread_id: string;
        subject: string;
        from_addr: string;
        received_at: string;
        summary: string | null;
        deadline: string | null;
        urgency: "high" | "mid" | "low" | null;
        target: "rep" | "staff" | "other" | null;
        status: EmailStatus;
      }>();

    const rows = results.map((row) => {
      const dashboardRow: DashboardEmailRow = {
        gmailId: row.gmail_id,
        threadId: row.thread_id,
        subject: row.subject,
        fromAddr: row.from_addr,
        receivedAt: row.received_at,
        summary: row.summary,
        deadline: row.deadline,
        urgency: row.urgency,
        target: row.target,
        status: row.status,
        actionLogs: [],
      };
      rowByInternalId.set(row.id, dashboardRow);
      return dashboardRow;
    });

    emailsByStatus[status] = rows;
    countsByStatus[status] = rows.length;
  }

  // 対象メール全件（内部id）分のaction_logsを、1回のクエリでまとめて取得する（各email_idにつき新しい順で直近10件のみ）
  const internalIds = Array.from(rowByInternalId.keys());
  if (internalIds.length > 0) {
    const placeholders = internalIds.map(() => "?").join(", ");
    const { results } = await db
      .prepare(
        `SELECT email_id, action, created_at FROM (
           SELECT email_id, action, created_at,
             ROW_NUMBER() OVER (PARTITION BY email_id ORDER BY created_at DESC, id DESC) AS rn
           FROM action_logs
           WHERE email_id IN (${placeholders})
         ) WHERE rn <= 10
         ORDER BY email_id, created_at DESC`
      )
      .bind(...internalIds)
      .all<{ email_id: number; action: ActionLogAction; created_at: string }>();

    for (const logRow of results) {
      const dashboardRow = rowByInternalId.get(logRow.email_id);
      if (dashboardRow) {
        dashboardRow.actionLogs.push({ action: logRow.action, createdAt: logRow.created_at });
      }
    }
  }

  return { emailsByStatus, countsByStatus };
}

/** ステータス更新API（updateEmailStatus）に指定できる遷移先ステータス（unreadへは戻せないため対象外） */
export type UpdatableEmailStatus = Exclude<EmailStatus, "unread">;

/** ステータス更新1件を試みた結果の種別 */
export type UpdateEmailStatusOutcome =
  | "updated" // 更新・ログ記録とも成功
  | "already_at_or_past" // 対象メールが既に指定ステータス（またはそれ以降）だった（逆戻りリクエストも含む。更新・ログ記録は行わない）
  | "not_found" // 対象メールがemailsテーブルに存在しない
  | "failed"; // D1への書き込みが失敗した

/** ステータス更新1件を試みた結果 */
export interface UpdateEmailStatusResult {
  outcome: UpdateEmailStatusOutcome;
  /** 更新後（更新しなかった場合は更新前）のステータス。not_foundの場合はnull */
  status: EmailStatus | null;
}

/**
 * 指定したgmail_idのメールのステータスをtargetStatusへ更新し、action_logsへ実際の遷移先1行のみを記録する。
 * emails.statusのUPDATEとaction_logsへのINSERTは、recordNotifications同様にdb.batch()でアトミックに実行する。
 *
 * 遷移ルール（unread → acknowledged → in_progress → done の一直線・前方向のみ）:
 * - 現在のステータスより後ろのステータスへの遷移のみ許可する（中間の読み飛ばしは可）
 * - 現在のステータスと同じ、またはそれより前（逆戻り）のステータスをリクエストされた場合は、
 *   更新・ログ記録とも行わず outcome: "already_at_or_past" を返す（冪等）
 */
export async function updateEmailStatus(
  db: D1Database,
  gmailId: string,
  targetStatus: UpdatableEmailStatus
): Promise<UpdateEmailStatusResult> {
  const row = await db
    .prepare(`SELECT id, status FROM emails WHERE gmail_id = ?`)
    .bind(gmailId)
    .first<{ id: number; status: EmailStatus }>();

  if (!row) {
    console.error(`[mail-watch] ステータス更新エラー: 対象のメールがemailsテーブルに見つかりませんでした (gmail_id=${gmailId})`);
    return { outcome: "not_found", status: null };
  }

  const currentIndex = EMAIL_STATUSES.indexOf(row.status);
  const targetIndex = EMAIL_STATUSES.indexOf(targetStatus);

  if (targetIndex <= currentIndex) {
    return { outcome: "already_at_or_past", status: row.status };
  }

  try {
    await db.batch([
      db.prepare(`UPDATE emails SET status = ? WHERE id = ?`).bind(targetStatus, row.id),
      db.prepare(`INSERT INTO action_logs (email_id, action) VALUES (?, ?)`).bind(row.id, targetStatus),
    ]);
    return { outcome: "updated", status: targetStatus };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[mail-watch] ステータス更新の書き込みに失敗しました (gmail_id=${gmailId}): ${errorMessage}`);
    return { outcome: "failed", status: row.status };
  }
}

/** 指定したgmail_idの一覧について、emailsテーブルの内部id(id)をまとめて1回のIN句クエリで引き当てる */
async function lookupEmailIdsByGmailIds(db: D1Database, gmailIds: string[]): Promise<Map<string, number>> {
  const placeholders = gmailIds.map(() => "?").join(", ");
  const { results } = await db
    .prepare(`SELECT id, gmail_id FROM emails WHERE gmail_id IN (${placeholders})`)
    .bind(...gmailIds)
    .all<{ id: number; gmail_id: string }>();

  const idByGmailId = new Map<string, number>();
  for (const row of results) {
    idByGmailId.set(row.gmail_id, row.id);
  }
  return idByGmailId;
}
