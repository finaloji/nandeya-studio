-- mail-watch 初期スキーマ
-- 日時カラム（received_at / deadline / last_notified_at / created_at）はすべて UTC 基準で保存する。
-- 表示時に JST へ変換する方針。

-- 取り込んだメール（1通 = 1行）
CREATE TABLE emails (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,          -- 内部ID（自動採番）
  gmail_id         TEXT    NOT NULL UNIQUE,                    -- GmailメッセージID（UNIQUEで二重取り込み防止）
  thread_id        TEXT    NOT NULL,                           -- GmailスレッドID
  subject          TEXT    NOT NULL,                           -- 件名
  from_addr        TEXT    NOT NULL,                           -- 送信者
  received_at      TEXT    NOT NULL,                           -- 受信日時（UTC）
  summary          TEXT,                                       -- AI要約（AI処理前はNULL）
  deadline         TEXT,                                       -- 期限（NULL可）
  urgency          TEXT    CHECK (urgency IN ('high', 'mid', 'low')),          -- 緊急度
  target           TEXT    CHECK (target IN ('rep', 'staff', 'other')),        -- 宛先分類
  status           TEXT    NOT NULL DEFAULT 'unread'
                           CHECK (status IN ('unread', 'acknowledged', 'in_progress', 'done')),  -- 対応ステータス
  notify_count     INTEGER NOT NULL DEFAULT 0,                 -- 通知回数
  last_notified_at TEXT,                                       -- 最終通知日時（UTC・NULL可）
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')) -- 行の作成日時（UTC）
);

-- ステータスでの絞り込みが主な読み取りパターン
CREATE INDEX idx_emails_status ON emails (status);

-- アクションログ（1イベント = 1行、追記専用）
CREATE TABLE action_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,                -- 内部ID（自動採番）
  email_id   INTEGER NOT NULL REFERENCES emails (id),          -- 対象メール（外部キー）
  action     TEXT    NOT NULL
                     CHECK (action IN ('notified', 'digest_notified', 'replied', 'acknowledged', 'in_progress', 'done')),  -- アクション種別
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))        -- 発生日時（UTC）
);

-- 対象メールでの絞り込みが主な読み取りパターン
CREATE INDEX idx_action_logs_email_id ON action_logs (email_id);
