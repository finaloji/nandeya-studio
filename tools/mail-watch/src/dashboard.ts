/**
 * mail-watch: 管理画面（ダッシュボード）のHTML生成ロジック
 *
 * `/` へのGETリクエストに対して返すHTMLを組み立てる。
 * D1から取得済みの4ステータス分のデータをHTMLへ埋め込み、タブの出し分けはページ内JavaScriptで行う
 * （タブ切り替えごとの再読み込み・別APIエンドポイントへの問い合わせは発生させない）。
 *
 * 注意: パスコード認証は本スプリントでは実装しない（後日追加予定）。
 * 検索エンジンにインデックスされないよう <meta name="robots" content="noindex"> のみ付与し、
 * URLの取り扱いに関する注意書き等はページ内に置かない（実装の複雑化を避けるための方針）。
 */

import type { DashboardData, DashboardEmailRow, EmailStatus } from "./db";
import { EMAIL_STATUSES } from "./db";

/** ステータスごとのタブ表示名 */
const STATUS_LABELS: Record<EmailStatus, string> = {
  unread: "未確認",
  acknowledged: "確認済み",
  in_progress: "対応中",
  done: "完了",
};

/** 緊急度ごとの表示名 */
const URGENCY_LABELS: Record<"high" | "mid" | "low", string> = {
  high: "緊急",
  mid: "中",
  low: "低",
};

/** 宛先分類ごとの表示名 */
const TARGET_LABELS: Record<"rep" | "staff" | "other", string> = {
  rep: "代表宛",
  staff: "スタッフ宛",
  other: "その他",
};

/**
 * 管理画面のHTML全体を組み立てる。
 * dataは4ステータス分すべてを含み、初期表示は「未確認」タブとする。
 */
export function renderDashboardHtml(data: DashboardData): string {
  const tabButtons = EMAIL_STATUSES.map(
    (status) => `
      <button
        type="button"
        class="tab-button${status === "unread" ? " is-active" : ""}"
        data-status="${status}"
        onclick="switchTab('${status}')"
      >${escapeHtml(STATUS_LABELS[status])} (${data.countsByStatus[status]})</button>`
  ).join("");

  const tabPanels = EMAIL_STATUSES.map(
    (status) => `
      <section
        class="tab-panel${status === "unread" ? " is-active" : ""}"
        id="panel-${status}"
        data-status="${status}"
      >${renderEmailList(data.emailsByStatus[status], status)}</section>`
  ).join("");

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>mail-watch 管理画面</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
<header class="page-header">
  <h1>mail-watch 管理画面</h1>
</header>
<nav class="tabs">${tabButtons}</nav>
<main>${tabPanels}</main>
<script>${DASHBOARD_SCRIPT}</script>
</body>
</html>`;
}

/** 1ステータス分のメール一覧HTMLを組み立てる。0件の場合は空状態メッセージを表示する */
function renderEmailList(emails: DashboardEmailRow[], status: EmailStatus): string {
  if (emails.length === 0) {
    return `<p class="empty-state">${escapeHtml(STATUS_LABELS[status])}のメールはありません</p>`;
  }

  return emails.map((email) => renderEmailCard(email)).join("");
}

/** 1件分のメールをカード状のHTMLとして組み立てる */
function renderEmailCard(email: DashboardEmailRow): string {
  const urgencyClass = email.urgency ? `urgency-${email.urgency}` : "urgency-unknown";
  const urgencyLabel = email.urgency ? URGENCY_LABELS[email.urgency] : "未判定";
  const targetLabel = email.target ? TARGET_LABELS[email.target] : "未判定";
  const targetClass = email.target && email.target !== "rep" ? "target-nonrep" : "target-rep";
  const summaryText = email.summary ?? "要約待ち";
  const deadlineText = email.deadline ?? "期限なし";
  const gmailUrl = `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(email.threadId)}`;

  return `
    <article class="email-card">
      <div class="email-card-top">
        <span class="badge ${urgencyClass}">${escapeHtml(urgencyLabel)}</span>
        <span class="badge ${targetClass}">${escapeHtml(targetLabel)}</span>
        <span class="badge status-badge">${escapeHtml(STATUS_LABELS[email.status])}</span>
      </div>
      <h2 class="email-subject">${escapeHtml(email.subject)}</h2>
      <p class="email-summary">${escapeHtml(summaryText)}</p>
      <dl class="email-meta">
        <div><dt>送信者</dt><dd>${escapeHtml(email.fromAddr)}</dd></div>
        <div><dt>受信日時</dt><dd>${escapeHtml(formatToJst(email.receivedAt))}</dd></div>
        <div><dt>期限</dt><dd>${escapeHtml(deadlineText)}</dd></div>
      </dl>
      <a class="gmail-link" href="${escapeHtmlAttribute(gmailUrl)}" target="_blank" rel="noopener noreferrer">Gmailで開く</a>
    </article>`;
}

/**
 * ISO 8601形式のUTC文字列（例: 2026-07-17T09:13:14.000Z）をJST表示用の文字列に変換する。
 * 外部ライブラリは使わず、+9時間の単純計算で行う。
 */
function formatToJst(isoUtc: string): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) {
    return isoUtc;
  }

  const jstMs = date.getTime() + 9 * 60 * 60 * 1000;
  const jst = new Date(jstMs);

  const year = jst.getUTCFullYear();
  const month = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jst.getUTCDate()).padStart(2, "0");
  const hours = String(jst.getUTCHours()).padStart(2, "0");
  const minutes = String(jst.getUTCMinutes()).padStart(2, "0");

  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

/** HTML内テキストとして埋め込む際のエスケープ */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** HTML属性値として埋め込む際のエスケープ（escapeHtmlと同等だが用途を明示するため分けている） */
function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value);
}

/** 管理画面のスタイル。モバイルファースト（カード縦積み・横スクロール前提のテーブルは使わない） */
const DASHBOARD_CSS = `
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0 12px 32px;
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
    background: #f4f5f7;
    color: #1a1a1a;
    overflow-x: hidden;
  }
  .page-header { padding: 16px 4px 8px; }
  .page-header h1 { font-size: 18px; margin: 0; }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    position: sticky;
    top: 0;
    background: #f4f5f7;
    padding: 8px 4px 12px;
    z-index: 10;
  }
  .tab-button {
    flex: 1 1 auto;
    min-width: 76px;
    padding: 12px 8px;
    font-size: 14px;
    border: 1px solid #ccc;
    border-radius: 8px;
    background: #fff;
    color: #333;
    cursor: pointer;
  }
  .tab-button.is-active {
    background: #1a73e8;
    border-color: #1a73e8;
    color: #fff;
    font-weight: bold;
  }
  .tab-panel { display: none; }
  .tab-panel.is-active { display: block; }
  .empty-state {
    text-align: center;
    color: #666;
    padding: 32px 8px;
  }
  .email-card {
    background: #fff;
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 12px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    max-width: 100%;
    overflow-wrap: break-word;
  }
  .email-card-top {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 8px;
  }
  .badge {
    display: inline-block;
    font-size: 12px;
    padding: 3px 8px;
    border-radius: 999px;
    background: #eee;
    color: #333;
  }
  .urgency-high { background: #fde0e0; color: #b3261e; font-weight: bold; }
  .urgency-mid { background: #fff2cc; color: #8a6d00; }
  .urgency-low { background: #e2f0e2; color: #1e7a1e; }
  .urgency-unknown { background: #eee; color: #666; }
  .target-nonrep { background: #ffe0f0; color: #a3005c; font-weight: bold; }
  .target-rep { background: #e6eefc; color: #1a4fa0; }
  .status-badge { background: #eee; color: #555; }
  .email-subject {
    font-size: 16px;
    margin: 0 0 6px;
    word-break: break-word;
  }
  .email-summary {
    font-size: 14px;
    color: #333;
    margin: 0 0 10px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .email-meta {
    margin: 0 0 12px;
    font-size: 13px;
    color: #555;
  }
  .email-meta > div { display: flex; gap: 6px; margin-bottom: 2px; }
  .email-meta dt { flex: 0 0 auto; color: #888; }
  .email-meta dd { margin: 0; word-break: break-word; }
  .gmail-link {
    display: block;
    text-align: center;
    padding: 12px;
    border-radius: 8px;
    background: #1a73e8;
    color: #fff;
    text-decoration: none;
    font-size: 14px;
  }
`;

/** タブ切り替え用のクライアントサイドJavaScript */
const DASHBOARD_SCRIPT = `
  function switchTab(status) {
    document.querySelectorAll(".tab-button").forEach(function (button) {
      button.classList.toggle("is-active", button.getAttribute("data-status") === status);
    });
    document.querySelectorAll(".tab-panel").forEach(function (panel) {
      panel.classList.toggle("is-active", panel.getAttribute("data-status") === status);
    });
  }
`;
