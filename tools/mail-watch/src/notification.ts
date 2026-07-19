/**
 * mail-watch: LINE通知要否の判定ロジック
 *
 * Gemini AIで整理済み（summary/deadline/urgency/targetが確定した）メールについて、
 * LINE通知すべきかどうかを判定する。実際のLINE push送信は対象外（後続スプリント）。
 */

import type { EmailAiFields } from "./gemini";

/** 通知要否判定の対象となる1件（AI整理が成功したメール） */
export interface NotificationCandidate {
  /** GmailメッセージID */
  gmailId: string;
  /** 宛先分類 */
  target: EmailAiFields["target"];
  /** 緊急度 */
  urgency: EmailAiFields["urgency"];
}

/** 1件の通知要否判定結果 */
export interface NotificationDecisionResult {
  /** GmailメッセージID */
  gmailId: string;
  /** 判定に使った宛先分類 */
  target: EmailAiFields["target"];
  /** 判定に使った緊急度 */
  urgency: EmailAiFields["urgency"];
  /** LINE通知すべきかどうか */
  shouldNotify: boolean;
}

/**
 * 1件のメールについて、LINE通知すべきかどうかを判定する。
 * 判定基準: target === "rep" かつ urgencyが"low"でない（"high"または"mid"）場合のみ通知すべき。
 * targetがnull、または"rep"以外（"staff"/"other"）の場合は通知不要。
 * urgencyがnullの場合は"low"と同等（緊急ではない）とみなし、通知不要とする（過剰通知を避ける側に倒す）。
 * AI整理自体が失敗したメールはこの関数の対象外（呼び出し元でフィルタ済みであることを前提とする）。
 */
export function shouldNotify(candidate: NotificationCandidate): boolean {
  if (candidate.target !== "rep") {
    return false;
  }

  return candidate.urgency === "high" || candidate.urgency === "mid";
}

/** 複数件の通知要否判定結果をまとめたサマリ */
export interface NotificationDecisionSummary {
  /** 判定対象件数（AI整理が成功した件数） */
  targetCount: number;
  /** 通知すべきと判定された件数 */
  shouldNotifyCount: number;
  /** 通知不要と判定された件数 */
  skipCount: number;
  /** メールごとの判定結果一覧（AI整理が失敗したメールは含まない） */
  results: NotificationDecisionResult[];
}

/**
 * AI整理が成功したメール一覧（NotificationCandidate[]）について、まとめて通知要否判定を行う。
 * AI整理自体が失敗したメールは呼び出し元で除外した上で渡すこと（判定対象外のため）。
 * 対象が0件の場合もエラーにはならず、全項目0件のサマリを返す。
 */
export function decideNotifications(candidates: NotificationCandidate[]): NotificationDecisionSummary {
  const results: NotificationDecisionResult[] = candidates.map((candidate) => ({
    gmailId: candidate.gmailId,
    target: candidate.target,
    urgency: candidate.urgency,
    shouldNotify: shouldNotify(candidate),
  }));

  const shouldNotifyCount = results.filter((r) => r.shouldNotify).length;

  return {
    targetCount: results.length,
    shouldNotifyCount,
    skipCount: results.length - shouldNotifyCount,
    results,
  };
}
