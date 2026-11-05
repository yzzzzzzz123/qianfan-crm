export function migrateMinutesHistory(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=20').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec("ALTER TABLE minutes_sync_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'incremental' CHECK(mode IN('incremental','history')); ALTER TABLE minutes_sync_runs ADD COLUMN cursor TEXT;");
    db.exec('INSERT INTO schema_version VALUES(20); COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
