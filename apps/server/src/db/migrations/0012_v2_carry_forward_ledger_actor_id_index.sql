-- V2 carry-forward: index on ledger_events.actor_id.
-- Audit-by-actor queries (e.g. "show me everything user X has done") were
-- previously full-table scans. Adding the index now avoids a perf cliff once
-- the audit UI ships in V2-004+. Cheap to add: append-only table, write cost
-- is one extra B-tree insert per ledger event.
CREATE INDEX IF NOT EXISTS `ledger_events_actor_idx` ON `ledger_events` (`actor_id`);
