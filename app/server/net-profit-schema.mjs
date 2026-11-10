// Business expenses may exceed the pre-expense profit. Preserve real losses.
export function migrateNetProfit(db){
 if(db.prepare('SELECT 1 FROM schema_version WHERE version=34').get())return;
 const source=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='contract_items'").get().sql;
 const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all(),indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='contract_items' AND sql IS NOT NULL").all();
 const sequence=db.prepare("SELECT seq FROM sqlite_sequence WHERE name='contract_items'").get()?.seq||0;
 const columns=db.prepare('PRAGMA table_info(contract_items)').all().map(r=>'"'+r.name+'"').join(',');
 db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE');try{
 for(const t of triggers)db.exec('DROP TRIGGER "'+t.name.replaceAll('"','""')+'"');
 const sql=source.replace(/CREATE TABLE\s+["`]?contract_items["`]?/i,'CREATE TABLE contract_items_net').replace(/CHECK\s*\(\s*margin\s*>=\s*0\s*\)/i,"CHECK(margin IS NULL OR typeof(margin)='integer')");
 db.exec(sql);db.exec(`INSERT INTO contract_items_net(${columns}) SELECT ${columns} FROM contract_items;DROP TABLE contract_items;ALTER TABLE contract_items_net RENAME TO contract_items;`);
 for(const index of indexes)db.exec(index.sql);for(const t of triggers)db.exec(t.sql);
 db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='contract_items'").run(sequence);
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('净毛利升级外键检查失败');db.exec('INSERT INTO schema_version VALUES(34);COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}finally{db.exec('PRAGMA foreign_keys=ON');}
}
