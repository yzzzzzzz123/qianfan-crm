export function migrateProfitAdmin(db){
 if(db.prepare('SELECT 1 FROM schema_version WHERE version=33').get())return;
 db.exec('BEGIN IMMEDIATE');try{
 db.exec(`ALTER TABLE contract_items ADD COLUMN business_expense INTEGER NOT NULL DEFAULT 0 CHECK(typeof(business_expense)='integer' AND business_expense>=0);
 ALTER TABLE contract_items ADD COLUMN margin_before_expense INTEGER;
 ALTER TABLE contract_items ADD COLUMN retired_at TEXT;
 UPDATE contract_items SET margin_before_expense=margin;
 CREATE TABLE record_recycle_bin(id INTEGER PRIMARY KEY AUTOINCREMENT,entity TEXT NOT NULL,record_id INTEGER NOT NULL,contract_id INTEGER NOT NULL REFERENCES contracts(id),payload TEXT NOT NULL,reason TEXT NOT NULL,deleted_by INTEGER NOT NULL REFERENCES users(id),deleted_at TEXT NOT NULL,restored_at TEXT);
 CREATE TRIGGER recycle_revision_insert AFTER INSERT ON record_recycle_bin BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
 CREATE TRIGGER recycle_revision_update AFTER UPDATE ON record_recycle_bin BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
 INSERT INTO schema_version VALUES(33);`);
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('商务费用升级外键检查失败');db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}
}
