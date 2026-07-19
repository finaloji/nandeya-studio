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
