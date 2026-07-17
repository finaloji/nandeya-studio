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
