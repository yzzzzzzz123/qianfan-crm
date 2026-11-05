export function migrateMinutesOrganizations(db){
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=18').get())return;
  // Rebuild only the source uniqueness constraint; child references keep the
  // original table name, IDs and credential keys throughout the migration.
  const objects=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='minutes_sources' AND type IN('index','trigger') AND sql IS NOT NULL").all();
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try{
    db.exec(`CREATE TABLE minutes_sources_v18(id TEXT PRIMARY KEY,member_id INTEGER NOT NULL REFERENCES users(id),corp_id TEXT NOT NULL,user_id TEXT NOT NULL,account_name TEXT NOT NULL,corp_name TEXT NOT NULL,credential_key TEXT NOT NULL,connection_state TEXT NOT NULL CHECK(connection_state IN('connected','disconnected')),collect_from TEXT NOT NULL,synced_until TEXT,last_synced_at TEXT,created_at TEXT NOT NULL,UNIQUE(corp_id,user_id),UNIQUE(member_id,corp_id));
      INSERT INTO minutes_sources_v18 SELECT * FROM minutes_sources;
      DROP TABLE minutes_sources;
      ALTER TABLE minutes_sources_v18 RENAME TO minutes_sources;
      ALTER TABLE minutes_authorizations ADD COLUMN credential_key TEXT;
      UPDATE minutes_authorizations SET credential_key=id;`);
    for(const {sql} of objects)db.exec(sql);
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('听记多组织升级引用校验失败');
    db.exec('INSERT INTO schema_version VALUES(18); COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}finally{db.exec('PRAGMA foreign_keys=ON');}
}
