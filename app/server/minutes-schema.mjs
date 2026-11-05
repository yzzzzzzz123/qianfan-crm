export function migrateMinutes(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=17').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE minutes_sources(id TEXT PRIMARY KEY,member_id INTEGER NOT NULL UNIQUE REFERENCES users(id),corp_id TEXT NOT NULL,user_id TEXT NOT NULL,account_name TEXT NOT NULL,corp_name TEXT NOT NULL,credential_key TEXT NOT NULL,connection_state TEXT NOT NULL CHECK(connection_state IN('connected','disconnected')),collect_from TEXT NOT NULL,synced_until TEXT,last_synced_at TEXT,created_at TEXT NOT NULL,UNIQUE(corp_id,user_id));
      CREATE TABLE minutes_authorizations(id TEXT PRIMARY KEY,member_id INTEGER NOT NULL REFERENCES users(id),status TEXT NOT NULL,candidate TEXT,error_message TEXT NOT NULL DEFAULT '',source_id TEXT REFERENCES minutes_sources(id),expires_at TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT);
      CREATE TABLE minutes_records(id INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL REFERENCES minutes_sources(id),external_id TEXT NOT NULL,title TEXT NOT NULL,start_time TEXT NOT NULL,duration_ms INTEGER NOT NULL CHECK(duration_ms>=0),media_state TEXT NOT NULL,media_reason TEXT NOT NULL DEFAULT '',customer_id INTEGER REFERENCES customers(id),opportunity_id INTEGER REFERENCES opportunities(id),revision INTEGER NOT NULL DEFAULT 1,synced_at TEXT NOT NULL,UNIQUE(source_id,external_id),CHECK(opportunity_id IS NULL OR customer_id IS NOT NULL));
      CREATE TABLE minutes_artifacts(record_id INTEGER NOT NULL REFERENCES minutes_records(id),kind TEXT NOT NULL,state TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',checked_at TEXT NOT NULL,succeeded_at TEXT,PRIMARY KEY(record_id,kind));
      CREATE TABLE minutes_sync_runs(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES minutes_sources(id),status TEXT NOT NULL,from_time TEXT NOT NULL,to_time TEXT NOT NULL,pages INTEGER NOT NULL DEFAULT 0,fetched INTEGER NOT NULL DEFAULT 0,error_message TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,finished_at TEXT);
      CREATE INDEX minutes_records_time ON minutes_records(source_id,start_time);
      CREATE INDEX minutes_records_customer ON minutes_records(customer_id,opportunity_id);
      CREATE INDEX minutes_runs_source ON minutes_sync_runs(source_id,created_at);
      ALTER TABLE activities ADD COLUMN minutes_record_id INTEGER REFERENCES minutes_records(id);
      CREATE UNIQUE INDEX activities_minutes ON activities(minutes_record_id) WHERE minutes_record_id IS NOT NULL;
    `);
    for(const table of ['minutes_sources','minutes_records','minutes_artifacts'])for(const op of ['INSERT','UPDATE','DELETE'])
      db.exec(`CREATE TRIGGER revision_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END`);
    db.exec('INSERT INTO schema_version VALUES(17); COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
