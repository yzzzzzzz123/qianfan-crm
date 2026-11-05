// Historical source rows may lack a customer; ordinary API creation still requires one.
export function migrateHistoricalOpportunityCustomers(db){
 if(db.prepare('SELECT 1 FROM schema_version WHERE version=31').get())return;
 const foreignKeys=db.prepare('PRAGMA foreign_keys').get().foreign_keys;
 db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 try{
  const q=s=>'"'+s.replaceAll('"','""')+'"';
  const auxiliary=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (type IN ('trigger','view') OR type='index' AND tbl_name='opportunities') ORDER BY type,name").all();
  for(const object of auxiliary)if(object.type!=='index')db.exec(`DROP ${object.type.toUpperCase()} ${q(object.name)}`);
  const original=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='opportunities'").get()?.sql;
  if(!original||!/customer_id INTEGER NOT NULL/i.test(original))throw Error('历史商机客户迁移需要已核验的客户列');
  const seq=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='opportunities'").get()?.seq;
  const cols=db.prepare('PRAGMA table_info(opportunities)').all().map(c=>q(c.name)).join(',');
  db.exec(original.replace(/CREATE TABLE\s+"?opportunities"?/i,'CREATE TABLE opportunities_v31').replace(/customer_id INTEGER NOT NULL/i,'customer_id INTEGER'));
  db.exec(`INSERT INTO opportunities_v31 (${cols}) SELECT ${cols} FROM opportunities; DROP TABLE opportunities; ALTER TABLE opportunities_v31 RENAME TO opportunities;`);
  if(seq!==undefined)db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='opportunities'").run(seq);
  for(const object of auxiliary)db.exec(object.sql);
  db.exec("CREATE TRIGGER opportunities_required_customer_insert BEFORE INSERT ON opportunities WHEN NEW.customer_id IS NULL BEGIN SELECT RAISE(ABORT,'CRM opportunity customer is required'); END; CREATE TRIGGER opportunities_required_customer_update BEFORE UPDATE ON opportunities WHEN NEW.customer_id IS NULL AND OLD.customer_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'CRM known opportunity customer cannot be cleared'); END;");
  if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('历史商机客户迁移外键检查失败');
  db.exec('INSERT INTO schema_version VALUES(31); UPDATE workspace_revision SET revision=revision+1 WHERE id=1; COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys='+foreignKeys);}
}
