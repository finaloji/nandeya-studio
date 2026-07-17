/**
 * mail-watch: Gmail API連携ロジック
 *
 * スプリント1-2時点の実装範囲:
 * - refresh tokenからaccess tokenを発行する
 * - access tokenでGmail検索（メッセージID一覧の取得）を行う
 * - 各メッセージの詳細（件名・送信者・受信日時・本文）を取得する
 *
 * D1への保存・Gemini要約・LINE通知・Cronからの呼び出しは対象外（後続スプリント）。
 */

import type { Env } from "./index";

/**
 * Gmail検索クエリ。
 * 「橋本大輝」または「代表取締役」を件名・本文どちらかに含み、直近2日以内、送信済みは除外する。
 * 運用しながら調整しやすいよう、ここに集約しておく。
 */
export const GMAIL_SEARCH_QUERY = '("橋本大輝" OR "代表取締役") newer_than:2d -in:sent';

/** 詳細取得を連続実行する際、Gmail APIのレート制限を誘発しないための間隔（ミリ秒） */
const DETAIL_FETCH_INTERVAL_MS = 150;

/** Gmail APIとのやり取り中に起きたエラーを、どの段階で起きたか分かる形で表す */
export class GmailApiError extends Error {
  /** どの段階で起きたエラーか */
  stage: "token" | "search" | "detail";
  /** Gmail/Google側から返ってきたHTTPステータス（あれば） */
  status?: number;
  /** レート制限エラーと判別できた場合 true */
  rateLimited: boolean;
  /** Google側のエラーレスポンス本文（デバッグ用） */
  detail?: unknown;

  constructor(
    stage: "token" | "search" | "detail",
    message: string,
    options?: { status?: number; rateLimited?: boolean; detail?: unknown }
  ) {
    super(message);
    this.name = "GmailApiError";
    this.stage = stage;
    this.status = options?.status;
    this.rateLimited = options?.rateLimited ?? false;
    this.detail = options?.detail;
  }
}

/** 検索・詳細取得で1件のメールについて取り出す情報 */
export interface GmailMessageDetail {
  /** GmailメッセージID */
  id: string;
  /** スレッドID（Gmailを開くリンクに使う） */
  threadId: string;
  /** 件名 */
  subject: string;
  /** 送信者（表示名を含む場合はそのまま） */
  from: string;
  /** 受信日時（ISO 8601） */
  receivedAt: string;
  /** 本文（読めるテキストに変換済み。未切り詰め） */
  body: string;
}

/**
 * 保存済みのGOOGLE_REFRESH_TOKEN等を使い、Googleの認可サーバーからaccess tokenを発行する。
 * access tokenは有効期限が短いため、都度発行する前提（キャッシュはしない）。
 */
export async function fetchAccessToken(env: Env): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  const json = await res.json<{ access_token?: string; error?: string; error_description?: string }>();

  if (!res.ok || !json.access_token) {
    throw new GmailApiError("token", `access tokenの取得に失敗しました: ${json.error ?? res.statusText}`, {
      status: res.status,
      rateLimited: res.status === 429,
      detail: json,
    });
  }

  return json.access_token;
}

/**
 * Gmail検索を行い、該当メッセージのID一覧を返す。0件の場合は空配列（正常系）。
 */
export async function searchMessageIds(accessToken: string): Promise<string[]> {
  const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  url.searchParams.set("q", GMAIL_SEARCH_QUERY);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const json = await res.json<{ messages?: { id: string; threadId: string }[]; error?: unknown }>();

  if (!res.ok) {
    throw new GmailApiError("search", `Gmail検索に失敗しました (status=${res.status})`, {
      status: res.status,
      rateLimited: res.status === 429,
      detail: json,
    });
  }

  return (json.messages ?? []).map((m) => m.id);
}

/** Gmail APIから1件のメッセージ詳細を取得し、必要な情報を取り出す */
export async function fetchMessageDetail(accessToken: string, messageId: string): Promise<GmailMessageDetail> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`);
  url.searchParams.set("format", "full");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const json = await res.json<GmailApiMessageResponse>();

  if (!res.ok) {
    throw new GmailApiError("detail", `メール詳細の取得に失敗しました (id=${messageId}, status=${res.status})`, {
      status: res.status,
      rateLimited: res.status === 429,
      detail: json,
    });
  }

  const headers = json.payload?.headers ?? [];
  const subject = findHeader(headers, "Subject") ?? "(件名なし)";
  const from = findHeader(headers, "From") ?? "(送信者不明)";
  const receivedAt = json.internalDate
    ? new Date(Number(json.internalDate)).toISOString()
    : new Date().toISOString();

  return {
    id: json.id,
    threadId: json.threadId,
    subject,
    from,
    receivedAt,
    body: extractReadableBody(json.payload),
  };
}

/**
 * 検索結果の全メッセージIDについて詳細を取得する。
 * レート制限を誘発しないよう、並列実行はせず一定間隔を空けて逐次実行する。
 */
export async function fetchMessageDetails(accessToken: string, messageIds: string[]): Promise<GmailMessageDetail[]> {
  const details: GmailMessageDetail[] = [];

  for (let i = 0; i < messageIds.length; i++) {
    if (i > 0) {
      await sleep(DETAIL_FETCH_INTERVAL_MS);
    }
    details.push(await fetchMessageDetail(accessToken, messageIds[i]));
  }

  return details;
}

/**
 * 本文を先頭から一定文字数に切り詰める。
 * 具体的な閾値は後続スプリントで確定させる想定のため、呼び出し側でmaxCharsを指定できる形にしている。
 */
export function truncateBody(body: string, maxChars: number): string {
  if (body.length <= maxChars) return body;
  return body.slice(0, maxChars);
}

// --- 以下、内部ヘルパー ---

interface GmailApiMessageResponse {
  id: string;
  threadId: string;
  internalDate?: string;
  payload?: GmailApiPart;
}

interface GmailApiPart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: GmailApiPart[];
}

function findHeader(headers: { name: string; value: string }[], name: string): string | undefined {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * メッセージのpayloadから、AIが読める程度のプレーンテキスト本文を取り出す。
 * text/plainがあれば優先し、無ければtext/htmlをタグ除去して使う。
 */
function extractReadableBody(payload: GmailApiPart | undefined): string {
  if (!payload) return "";

  const plain = findPartBody(payload, "text/plain");
  if (plain) return decodeBase64Url(plain);

  const html = findPartBody(payload, "text/html");
  if (html) return htmlToText(decodeBase64Url(html));

  return "";
}

/** 指定のmimeTypeに一致するパートのbody.dataを再帰的に探す */
function findPartBody(part: GmailApiPart, mimeType: string): string | undefined {
  if (part.mimeType === mimeType && part.body?.data) {
    return part.body.data;
  }
  for (const child of part.parts ?? []) {
    const found = findPartBody(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

/** Gmail APIのbase64url文字列をデコードし、UTF-8文字列として返す */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** HTML本文を簡易的にプレーンテキスト化する（タグ機械除去。精度は求めない） */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
