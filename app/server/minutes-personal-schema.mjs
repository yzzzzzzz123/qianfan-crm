export function migratePersonalMinutes(db){
 if(db.prepare('SELECT 1 FROM schema_version WHERE version=27').get())return;
 const objects=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='minutes_sources' AND type IN('index','trigger') AND sql IS NOT NULL").all();
 db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 try{
  db.exec(`CREATE TABLE minutes_sources_v27(id TEXT PRIMARY KEY,member_id INTEGER NOT NULL REFERENCES users(id),corp_id TEXT,user_id TEXT,account_name TEXT NOT NULL,corp_name TEXT NOT NULL,credential_key TEXT NOT NULL,connection_state TEXT NOT NULL CHECK(connection_state IN('connected','disconnected')),collect_from TEXT NOT NULL,synced_until TEXT,last_synced_at TEXT,created_at TEXT NOT NULL,provider TEXT NOT NULL DEFAULT 'dws' CHECK(provider IN('dws','personal_mcp')),UNIQUE(corp_id,user_id),UNIQUE(member_id,corp_id),CHECK((provider='dws' AND corp_id IS NOT NULL AND user_id IS NOT NULL) OR (provider='personal_mcp' AND corp_id IS NULL AND user_id IS NULL)));
   INSERT INTO minutes_sources_v27 SELECT *, 'dws' FROM minutes_sources;
   DROP TABLE minutes_sources;
   ALTER TABLE minutes_sources_v27 RENAME TO minutes_sources;
   CREATE UNIQUE INDEX minutes_personal_grant ON minutes_sources(credential_key) WHERE provider='personal_mcp';`);
  for(const {sql} of objects)db.exec(sql);
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('个人听记升级引用校验失败');
  db.exec('INSERT INTO schema_version VALUES(27); COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys=ON');}
}
