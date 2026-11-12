// Keep original events and their audit trail when follow-ups are corrected.
export function migrateActivityCorrections(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=36').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE activities ADD COLUMN event_managed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE activity_events ADD COLUMN action TEXT NOT NULL DEFAULT '';
      ALTER TABLE activity_events ADD COLUMN updated_at TEXT;
      ALTER TABLE activity_events ADD COLUMN updated_by INTEGER REFERENCES users(id);
      ALTER TABLE activity_events ADD COLUMN voided_at TEXT;
      ALTER TABLE activity_events ADD COLUMN void_reason TEXT NOT NULL DEFAULT '';
      UPDATE activities SET event_managed=1 WHERE EXISTS(SELECT 1 FROM activity_events e WHERE e.activity_id=activities.id);
      UPDATE activity_events SET action=COALESCE((SELECT a.action FROM activities a WHERE a.id=activity_events.activity_id),'')
        WHERE (SELECT count(*) FROM activity_events e WHERE e.activity_id=activity_events.activity_id)=1;
      CREATE INDEX activity_events_credited_date ON activity_events(credited_user_id,activity_date,voided_at);
      INSERT INTO schema_version VALUES(36);
      UPDATE workspace_revision SET revision=revision+1 WHERE id=1;
      COMMIT;`);
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
