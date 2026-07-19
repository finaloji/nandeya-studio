/**
 * mail-watch: LINE Messaging API連携ロジック（通知送信）
 *
 * 通知要否判定（notification.ts）でshouldNotify: trueとなったメール1件について、
 * Flex Messageを組み立ててLINE Messaging APIへpush送信する。
 * 複数件ある場合の間隔制御・逐次処理・失敗時の継続は呼び出し元（index.ts）で行う。
 */

import type { EmailAiFields } from "./gemini";

/** 連続してLINE APIを呼び出す際、レート制限を誘発しないための間隔（ミリ秒） */
export const LINE_CALL_INTERVAL_MS = 150;

/** LINE Messaging APIのpush送信エンドポイント */
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

/** urgency値を通知カード表示用の日本語ラベルに変換する。通知対象はhigh/midのみのため、それ以外は想定しない */
const URGENCY_LABELS: Partial<Record<NonNullable<EmailAiFields["urgency"]>, string>> = {
  high: "至急",
  mid: "要対応",
};

/** LINE API呼び出し中に起きたエラーを、何が起きたか分かる形で表す */
export class LineApiError extends Error {
  /** LINE側から返ってきたHTTPステータス（呼び出し自体が失敗した場合は無し） */
  status?: number;
  /** レート制限エラーと判別できた場合 true */
  rateLimited: boolean;
  /** デバッグ用の詳細情報（LINE側のエラーレスポンス本文など） */
  detail?: unknown;

  constructor(message: string, options?: { status?: number; rateLimited?: boolean; detail?: unknown }) {
    super(message);
    this.name = "LineApiError";
    this.status = options?.status;
    this.rateLimited = options?.rateLimited ?? false;
    this.detail = options?.detail;
  }
}

/** LINE通知1件を組み立てるのに必要な情報（通知要否判定を通過したメール1件分） */
export interface LineNotificationInput {
  /** 件名。空文字の場合はカード側で「(件名なし)」と表示する */
  subject: string;
  /** 送信者（Fromヘッダーの表示内容） */
  from: string;
  /** スレッドID（Gmailを開くボタンのリンク先組み立てに使う） */
  threadId: string;
  /** AI要約。nullの場合はカード側で「要約なし」と表示する */
  summary: EmailAiFields["summary"];
  /** 期限（ISO形式文字列）。nullの場合はカード側で「期限なし」と表示する */
  deadline: EmailAiFields["deadline"];
  /** 緊急度。判定基準上ここに来るのはhigh/midのみを想定 */
  urgency: EmailAiFields["urgency"];
}

/**
 * 1件のメールについてFlex Messageを組み立て、LINE Messaging APIへpush送信する。
 * 「管理画面を開く」ボタンは本スプリントでは含めない（管理画面実装スプリントで追加予定）。
 * 呼び出し自体の失敗・LINE側からのエラー応答（レート制限含む）はいずれもLineApiErrorとして投げる。
 */
export async function pushLineNotification(
  channelAccessToken: string,
  targetUserId: string,
  input: LineNotificationInput
): Promise<void> {
  const message = buildFlexMessage(input);

  let res: Response;
  try {
    res = await fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        to: targetUserId,
        messages: [message],
      }),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new LineApiError(`LINE APIの呼び出しに失敗しました: ${errorMessage}`, { detail: error });
  }

  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = undefined;
    }
    throw new LineApiError(`LINE APIの呼び出しに失敗しました (status=${res.status})`, {
      status: res.status,
      rateLimited: res.status === 429,
      detail,
    });
  }
}

/** Flex Messageのメッセージオブジェクト（messages配列の1要素分）を組み立てる */
function buildFlexMessage(input: LineNotificationInput): object {
  const subjectText = input.subject === "" ? "(件名なし)" : input.subject;
  const summaryText = input.summary ?? "要約なし";
  const deadlineText = input.deadline ?? "期限なし";
  const urgencyText = input.urgency ? URGENCY_LABELS[input.urgency] ?? input.urgency : "";
  const gmailUrl = `https://mail.google.com/mail/u/0/#all/${input.threadId}`;

  return {
    type: "flex",
    altText: `【${urgencyText}】${subjectText}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: urgencyText,
            weight: "bold",
            size: "sm",
            color: input.urgency === "high" ? "#e53935" : "#fb8c00",
          },
          {
            type: "text",
            text: subjectText,
            weight: "bold",
            size: "md",
            wrap: true,
          },
          {
            type: "text",
            text: `送信者: ${input.from}`,
            size: "sm",
            color: "#666666",
            wrap: true,
          },
          {
            type: "text",
            text: summaryText,
            size: "sm",
            wrap: true,
            margin: "md",
          },
          {
            type: "text",
            text: `期限: ${deadlineText}`,
            size: "sm",
            color: "#666666",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "uri",
              label: "Gmailで開く",
              uri: gmailUrl,
            },
          },
          // 「管理画面を開く」ボタンは本スプリントでは含めない。管理画面実装スプリントで追加する。
        ],
      },
    },
  };
}

/** 朝のまとめ通知1件（1通の箇条書きに含める1メール分）の情報。件名・送信者のみを持つ */
export interface MorningDigestItem {
  /** 件名。空文字の場合はカード側で「(件名なし)」と表示する */
  subject: string;
  /** 送信者（Fromヘッダーの表示内容） */
  from: string;
}

/** 朝のまとめ通知で箇条書き表示する件数の上限。超過分は「他N件」として省略表示する */
const MORNING_DIGEST_MAX_ITEMS = 20;

/**
 * 「未対応メールN件」の朝のまとめ通知を1通のFlex MessageとしてLINE Messaging APIへpush送信する。
 * 個別メールごとのGmailリンクは含めず、代わりに管理画面（dashboardUrl）を開くボタンを1つ含める。
 * itemsの件数がMORNING_DIGEST_MAX_ITEMSを超える場合は、上限件数まで表示し「他N件」と省略件数を明示する
 * （全件を複数通に分割して送ることはしない）。
 * 呼び出し自体の失敗・LINE側からのエラー応答（レート制限含む）はいずれもLineApiErrorとして投げる。
 */
export async function pushMorningDigestNotification(
  channelAccessToken: string,
  targetUserId: string,
  items: MorningDigestItem[],
  dashboardUrl: string
): Promise<void> {
  const message = buildMorningDigestFlexMessage(items, dashboardUrl);

  let res: Response;
  try {
    res = await fetch(LINE_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        to: targetUserId,
        messages: [message],
      }),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new LineApiError(`LINE APIの呼び出しに失敗しました: ${errorMessage}`, { detail: error });
  }

  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = undefined;
    }
    throw new LineApiError(`LINE APIの呼び出しに失敗しました (status=${res.status})`, {
      status: res.status,
      rateLimited: res.status === 429,
      detail,
    });
  }
}

/**
 * まとめ通知のFlex Messageのメッセージオブジェクト（messages配列の1要素分）を組み立てる。
 * 上限件数（MORNING_DIGEST_MAX_ITEMS）まで箇条書きし、超過分は「他N件」の1行にまとめる。
 */
function buildMorningDigestFlexMessage(items: MorningDigestItem[], dashboardUrl: string): object {
  const displayItems = items.slice(0, MORNING_DIGEST_MAX_ITEMS);
  const omittedCount = items.length - displayItems.length;

  const itemContents: object[] = displayItems.map((item) => ({
    type: "box",
    layout: "vertical",
    margin: "md",
    contents: [
      {
        type: "text",
        text: item.subject === "" ? "(件名なし)" : item.subject,
        weight: "bold",
        size: "sm",
        wrap: true,
      },
      {
        type: "text",
        text: `送信者: ${item.from}`,
        size: "xs",
        color: "#666666",
        wrap: true,
      },
    ],
  }));

  if (omittedCount > 0) {
    itemContents.push({
      type: "box",
      layout: "vertical",
      margin: "md",
      contents: [
        {
          type: "text",
          text: `他${omittedCount}件`,
          size: "xs",
          color: "#666666",
        },
      ],
    });
  }

  return {
    type: "flex",
    altText: `未対応メール ${items.length}件`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        contents: [
          {
            type: "text",
            text: `未対応メール ${items.length}件`,
            weight: "bold",
            size: "md",
          },
          ...itemContents,
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "uri",
              label: "管理画面を開く",
              uri: dashboardUrl,
            },
          },
        ],
      },
    },
  };
}
