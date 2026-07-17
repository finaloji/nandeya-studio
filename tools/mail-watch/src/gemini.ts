/**
 * mail-watch: Gemini API連携ロジック（メールのAI整理）
 *
 * D1へ新規保存されたメール1件について、件名・送信者・本文をGeminiへ渡し、
 * summary/deadline/urgency/targetをJSON形式で受け取る。
 * LINE通知・通知要否判定・Cronからの呼び出しは対象外（後続スプリント）。
 */

import type { GmailMessageDetail } from "./gmail";
import { truncateBody } from "./gmail";

/** Geminiに渡す本文の最大文字数。運用しながら調整しやすいよう定数にまとめておく */
export const GEMINI_BODY_MAX_CHARS = 4000;

/** 連続してGemini APIを呼び出す際、レート制限を誘発しないための間隔（ミリ秒） */
export const GEMINI_CALL_INTERVAL_MS = 150;

/** 使用するGeminiモデル名 */
const GEMINI_MODEL = "gemini-flash-latest";

/** urgencyカラムが取りうる値（D1のCHECK制約と一致させること） */
const VALID_URGENCY_VALUES = ["high", "mid", "low"] as const;
/** targetカラムが取りうる値（D1のCHECK制約と一致させること） */
const VALID_TARGET_VALUES = ["rep", "staff", "other"] as const;

/** Geminiから受け取り、D1のemails行に反映する4項目。不明な項目はnull */
export interface EmailAiFields {
  summary: string | null;
  deadline: string | null;
  urgency: "high" | "mid" | "low" | null;
  target: "rep" | "staff" | "other" | null;
}

/** Gemini連携中に起きたエラーを、どの段階で起きたか分かる形で表す */
export class GeminiApiError extends Error {
  /** どの段階で起きたエラーか（呼び出し自体の失敗 / JSONパース失敗） */
  stage: "call" | "parse";
  /** Gemini側から返ってきたHTTPステータス（callステージのみ） */
  status?: number;
  /** レート制限エラーと判別できた場合 true */
  rateLimited: boolean;
  /** デバッグ用の詳細情報 */
  detail?: unknown;

  constructor(stage: "call" | "parse", message: string, options?: { status?: number; rateLimited?: boolean; detail?: unknown }) {
    super(message);
    this.name = "GeminiApiError";
    this.stage = stage;
    this.status = options?.status;
    this.rateLimited = options?.rateLimited ?? false;
    this.detail = options?.detail;
  }
}

/**
 * 1件のメール（件名・送信者・本文）をGeminiへ渡し、AI整理結果（EmailAiFields）を得る。
 * 本文はGEMINI_BODY_MAX_CHARSまで切り詰めてから渡す。本文が空文字列でも呼び出し自体は行う。
 * 呼び出し自体の失敗はstage="call"、応答が期待した形式のJSONでない場合はstage="parse"のGeminiApiErrorを投げる。
 */
export async function classifyEmail(apiKey: string, email: GmailMessageDetail): Promise<EmailAiFields> {
  const truncatedBody = truncateBody(email.body, GEMINI_BODY_MAX_CHARS);
  const prompt = buildPrompt(email.subject, email.from, truncatedBody);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GeminiApiError("call", `Gemini APIの呼び出しに失敗しました: ${message}`, { detail: error });
  }

  const json = await res.json<GeminiGenerateContentResponse>();

  if (!res.ok) {
    throw new GeminiApiError("call", `Gemini APIの呼び出しに失敗しました (status=${res.status})`, {
      status: res.status,
      rateLimited: res.status === 429,
      detail: json,
    });
  }

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    throw new GeminiApiError("parse", "Geminiの応答からテキストを取り出せませんでした", { detail: json });
  }

  return parseAiFields(text);
}

/** Geminiへのプロンプトを組み立てる。JSON形式での出力・不明項目はnullを明示的に指示する */
function buildPrompt(subject: string, from: string, body: string): string {
  return `あなたは会社の代表宛に届いたメールを仕分けるアシスタントです。以下のメール情報を読み、次の4項目をJSON形式のみで出力してください。説明文やコードブロックの記法は不要です。JSONオブジェクト1つだけを出力してください。

出力項目:
- summary: メール内容の要約（日本語、1〜2文程度）。判断できない場合はnull
- deadline: 返信・対応の期限（メール本文に明記されている場合のみ、可能な範囲でISO 8601形式の日付。言及がない・読み取れない場合はnull）
- urgency: 緊急度。"high"（至急対応が必要）/ "mid"（数日以内に対応）/ "low"（急ぎではない）のいずれか。判断できない場合はnull
- target: 誰宛の内容か。"rep"（代表者本人が対応すべき）/ "staff"（担当者・スタッフが対応すべき）/ "other"（どちらでもない・判断不要）のいずれか。判断できない場合はnull

不明な項目は必ずnullとしてください。無理に値を埋めないでください。

件名: ${subject}
送信者: ${from}
本文:
${body}

出力形式の例:
{"summary": "...", "deadline": "2026-07-20", "urgency": "high", "target": "rep"}`;
}

/**
 * Geminiのテキスト応答をパースし、EmailAiFieldsとして取り出す。
 * - JSONとしてパースできない場合はGeminiApiError(stage="parse")を投げる
 * - urgency/targetが許容値以外の場合は、その項目のみnullとして扱う（他の項目は活かす）
 * - Markdownのコードブロック記法（```json ... ```）で囲まれている場合は取り除いてからパースする
 */
function parseAiFields(text: string): EmailAiFields {
  const stripped = stripCodeFence(text).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    throw new GeminiApiError("parse", "Geminiの応答をJSONとしてパースできませんでした", { detail: text });
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new GeminiApiError("parse", "Geminiの応答が期待したJSON形式（オブジェクト）ではありませんでした", { detail: text });
  }

  const record = parsed as Record<string, unknown>;

  return {
    summary: typeof record.summary === "string" ? record.summary : null,
    deadline: typeof record.deadline === "string" ? record.deadline : null,
    urgency: isValidUrgency(record.urgency) ? record.urgency : null,
    target: isValidTarget(record.target) ? record.target : null,
  };
}

/** ```json ... ``` のようなMarkdownコードブロック記法で囲まれていた場合、中身のみを取り出す */
function stripCodeFence(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1] : text;
}

function isValidUrgency(value: unknown): value is "high" | "mid" | "low" {
  return typeof value === "string" && (VALID_URGENCY_VALUES as readonly string[]).includes(value);
}

function isValidTarget(value: unknown): value is "rep" | "staff" | "other" {
  return typeof value === "string" && (VALID_TARGET_VALUES as readonly string[]).includes(value);
}

/** Gemini generateContent APIのレスポンス型（必要な部分のみ） */
interface GeminiGenerateContentResponse {
  candidates?: {
    content?: {
      parts?: { text?: string }[];
    };
  }[];
}
