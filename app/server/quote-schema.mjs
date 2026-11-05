import {createHash} from 'node:crypto';
import {deriveQuoteTotals} from './quote-values.mjs';

// The two totals are derived from quote items. Preserve exceptional old values
// as immutable migration evidence before removing their duplicate storage.
export function migrateQuoteTotals(db){
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=12').get())return;
  db.exec('BEGIN IMMEDIATE');
  try{
    const at=new Date().toISOString();
    for(const row of db.prepare('SELECT id,items,amount,list_amount,discount_amount FROM quotes ORDER BY id').all()){
      const derived=deriveQuoteTotals(row.items);
      if(row.list_amount===derived.list_amount&&row.discount_amount===derived.discount_amount)continue;
      const payload=JSON.stringify(row);
      const fingerprint=createHash('sha256').update('schema12:quotes:'+row.id+':'+payload).digest('hex');
      const existing=db.prepare('SELECT payload FROM source_records WHERE fingerprint=?').get(fingerprint);
      if(existing&&existing.payload!==payload)throw new Error('报价升级历史证据指纹冲突，未覆盖已有记录');
      if(!existing)db.prepare('INSERT INTO source_records(source,source_table,source_id,entity,entity_id,payload,source_file,sheet_name,row_number,imported_at,fingerprint,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('schema12报价结构迁移','quotes',String(row.id),'quote',row.id,payload,'schema11数据库迁移','quotes',row.id,at,fingerprint,'archived','原价与折扣汇总不能从原明细精确还原；保留原记录，报价明细及金额未修改');
    }
    db.exec('ALTER TABLE quotes DROP COLUMN list_amount; ALTER TABLE quotes DROP COLUMN discount_amount;');
    db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('报价结构升级外键检查失败');
    db.exec('INSERT INTO schema_version VALUES(12); COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
