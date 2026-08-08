-- mail-watch: urgency（緊急度）を importance（重要度）へ置き換え
--
-- 「urgency（時間的な切迫度）」という概念を廃止し、「importance（対応を怠った場合の
-- 業務上の影響の大きさ）」という概念へ置き換える。deadline（期限）カラムは変更しない
-- （時間的な切迫度は引き続きdeadlineが担う）。
--
-- 判定基準が変わるため、既存のurgencyの値はimportanceへ引き継がない（NULLから開始する）。
--
-- SQLiteのALTER TABLE ... RENAME COLUMNは、テーブル定義内のCHECK制約に含まれる列参照名も
-- 追従して書き換える（動作確認済み: RENAME後にCHECK (importance IN ('high','mid','low')) と
-- なり、値域チェックも正しく機能することをローカルD1で確認済み）。そのためRENAME COLUMNのみで
-- 完結させる（新カラム追加→旧カラム削除、のような複数ステップは不要）。

ALTER TABLE emails RENAME COLUMN urgency TO importance;
