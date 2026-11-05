// Replacing an imported opportunity list must not cascade-delete follow-ups,
// recordings or confirmed evidence that still references an old opportunity.
export function migrateOpportunityArchive(db){
 if(db.prepare('SELECT 1 FROM schema_version WHERE version=28').get())return;
 const foreignKeys=db.prepare('PRAGMA foreign_keys').get().foreign_keys;
 db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 try{
  const q=s=>'"'+s.replaceAll('"','""')+'"';
  const auxiliary=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (type IN ('trigger','view') OR type='index' AND tbl_name IN ('opportunities','contracts')) ORDER BY type,name").all();
  for(const object of auxiliary)if(object.type!=='index')db.exec(`DROP ${object.type.toUpperCase()} ${q(object.name)}`);
  for(const table of ['opportunities','contracts']){
   const original=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql;
   if(!original||!/owner_id INTEGER NOT NULL/i.test(original))throw Error('历史销售归属迁移需要已核验的负责人列');
   const seq=db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get(table)?.seq;
   const cols=db.prepare(`PRAGMA table_info(${q(table)})`).all().map(c=>q(c.name)).join(',');
   db.exec(original.replace(new RegExp('CREATE TABLE\\s+"?'+table+'"?','i'),'CREATE TABLE '+table+'_v28').replace(/owner_id INTEGER NOT NULL/i,'owner_id INTEGER'));
   db.exec(`INSERT INTO ${table}_v28 (${cols}) SELECT ${cols} FROM ${q(table)}; DROP TABLE ${q(table)}; ALTER TABLE ${table}_v28 RENAME TO ${table};`);
   if(seq!==undefined)db.prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?').run(seq,table);
  }
  for(const object of auxiliary)db.exec(object.sql);
  db.exec('ALTER TABLE opportunities ADD COLUMN archived_at TEXT; CREATE INDEX opportunities_active ON opportunities(archived_at,owner_id);');
  for(const table of ['opportunities','contracts'])db.exec(`CREATE TRIGGER ${table}_required_owner_insert BEFORE INSERT ON ${table} WHEN NEW.owner_id IS NULL BEGIN SELECT RAISE(ABORT,'CRM business owner is required'); END;
   CREATE TRIGGER ${table}_required_owner_update BEFORE UPDATE ON ${table} WHEN NEW.owner_id IS NULL AND OLD.owner_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'CRM known business owner cannot be cleared'); END;`);
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('商机保留归档迁移外键检查失败');
  db.exec('INSERT INTO schema_version VALUES(28); UPDATE workspace_revision SET revision=revision+1 WHERE id=1; COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys='+foreignKeys);}
}
