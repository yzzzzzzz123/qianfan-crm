// Historical customer masters may lack one authoritative owner even when their
// opportunities and contracts have explicit salespeople. Keep that absence;
// ordinary inserts still require an owner and known owners cannot be cleared.
export function migrateHistoricalCustomerOwners(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=13').get())return;
  const foreignKeys=db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    const original=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='customers'").get()?.sql;
    if(!original||!/owner_id INTEGER NOT NULL/i.test(original))throw new Error('历史客户迁移需要已核验的负责人约束');
    const auxiliary=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND (type IN ('trigger','view') OR type='index' AND tbl_name='customers') ORDER BY type,name").all();
    const quote=s=>'"'+s.replaceAll('"','""')+'"';
    const sequence=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='customers'").get()?.seq;
    const cols=db.prepare('PRAGMA table_info(customers)').all().map(c=>quote(c.name)).join(',');
    for(const object of auxiliary)if(object.type!=='index')db.exec(`DROP ${object.type.toUpperCase()} ${quote(object.name)}`);
    db.exec(original.replace(/CREATE TABLE\s+"?customers"?/i,'CREATE TABLE customers_v13').replace(/owner_id INTEGER NOT NULL/i,'owner_id INTEGER'));
    db.exec(`INSERT INTO customers_v13 (${cols}) SELECT ${cols} FROM customers; DROP TABLE customers; ALTER TABLE customers_v13 RENAME TO customers;`);
    for(const object of auxiliary)db.exec(object.sql);
    if(sequence!==undefined)db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='customers'").run(sequence);
    db.exec(`CREATE TRIGGER customers_required_owner_insert BEFORE INSERT ON customers WHEN NEW.owner_id IS NULL BEGIN SELECT RAISE(ABORT,'CRM customer owner is required'); END;
      CREATE TRIGGER customers_required_owner_update BEFORE UPDATE ON customers WHEN NEW.owner_id IS NULL AND OLD.owner_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'CRM customer known owner cannot be cleared'); END;`);
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('历史客户迁移外键检查失败');
    db.exec('INSERT INTO schema_version VALUES(13); UPDATE workspace_revision SET revision=revision+1 WHERE id=1; COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  finally{db.exec('PRAGMA foreign_keys='+foreignKeys);}
}
