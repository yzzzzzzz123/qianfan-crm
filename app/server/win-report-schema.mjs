export function migrateWinReports(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=37').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE win_report_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK(kind IN('won','test')),
      opportunity_id INTEGER REFERENCES opportunities(id) ON DELETE SET NULL,
      contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
      snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
      created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX win_report_first_won ON win_report_events(opportunity_id) WHERE kind='won';
      CREATE TABLE win_report_deliveries(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES win_report_events(id) ON DELETE CASCADE,
        group_key TEXT NOT NULL,group_name TEXT NOT NULL,conversation_id TEXT NOT NULL,
        robot_code TEXT NOT NULL,template_id TEXT NOT NULL,out_track_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN('pending','sending','sent','failed','uncertain','skipped')),
        card_created INTEGER NOT NULL DEFAULT 0 CHECK(card_created IN(0,1)),
        attempts INTEGER NOT NULL DEFAULT 0,
        error_code TEXT NOT NULL DEFAULT '',error_message TEXT NOT NULL DEFAULT '',
        next_retry_at TEXT,lease_until TEXT,sent_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        UNIQUE(event_id,group_key));
      CREATE INDEX win_report_due ON win_report_deliveries(status,next_retry_at,id);
      CREATE TRIGGER revision_win_report_insert AFTER INSERT ON win_report_deliveries BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
      CREATE TRIGGER revision_win_report_update AFTER UPDATE ON win_report_deliveries BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
      INSERT INTO schema_version VALUES(37);
      COMMIT;`);
  }catch(error){db.exec('ROLLBACK');throw error;}
}
