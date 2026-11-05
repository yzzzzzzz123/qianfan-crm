import {createHash} from 'node:crypto';

export const RETIRED_FIELDS_30={contracts:['recurring_amount','auto_renew']};
const archiveSource='schema30续约字段清理';
const triggerEdits={
  contracts_acceptance_insert:[" OR typeof(NEW.recurring_amount)<>'integer'",''],
  contracts_acceptance_update:[" OR typeof(NEW.recurring_amount)<>'integer'",''],
  contracts_production_insert:['NEW.recurring_amount<0 OR NEW.recurring_amount>NEW.amount OR NEW.auto_renew NOT IN (0,1) OR ',''],
  contracts_production_update:['NEW.recurring_amount<0 OR NEW.recurring_amount>NEW.amount OR NEW.auto_renew NOT IN (0,1) OR ',''],
};

// Retain every original value as source evidence. Renewal labels and expiry dates
// are independent business facts and must not be inferred from these old fields.
export function migrateRetiredRenewalFields(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=30').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const at=new Date().toISOString();
    for(const row of db.prepare('SELECT id,recurring_amount,auto_renew FROM contracts ORDER BY id').all()) {
      const payload=JSON.stringify(row),sourceId=String(row.id)+':renewal_fields';
      const fingerprint=createHash('sha256').update(`schema30:contracts:${sourceId}:${payload}`).digest('hex');
      const expected={source:archiveSource,source_table:'contracts',source_id:sourceId,entity:'contract',entity_id:row.id,payload,status:'archived'};
      const existing=db.prepare('SELECT source,source_table,source_id,entity,entity_id,payload,status FROM source_records WHERE fingerprint=?').get(fingerprint);
      if(existing&&Object.entries(expected).some(([key,value])=>existing[key]!==value))throw new Error('续约字段原值证据冲突，未删除字段');
      const sameSource=db.prepare('SELECT fingerprint,payload FROM source_records WHERE source=? AND source_table=? AND source_id=?').all(archiveSource,'contracts',sourceId);
      if(sameSource.some(item=>item.fingerprint!==fingerprint||item.payload!==payload))throw new Error('续约字段已有来源与当前旧值不一致，未覆盖原资料');
      if(!existing)db.prepare('INSERT INTO source_records(source,source_table,source_id,entity,entity_id,payload,source_file,sheet_name,row_number,imported_at,fingerprint,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(archiveSource,'contracts',sourceId,'contract',row.id,payload,'schema29数据库原字段','contracts',row.id,at,fingerprint,'archived','停用的续费金额及自动续约标记原值完整归档；不推定产品续费标签或产品到期日');
    }
    const triggers=[];
    for(const [name,[before,after]] of Object.entries(triggerEdits)) {
      const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql;
      if(!sql?.includes(before))throw new Error(`续约字段约束结构不符：${name}`);
      triggers.push(sql.replace(before,after));
      db.exec(`DROP TRIGGER ${name}`);
    }
    for(const field of RETIRED_FIELDS_30.contracts)db.exec(`ALTER TABLE contracts DROP COLUMN ${field}`);
    for(const sql of triggers)db.exec(sql);
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('续约字段清理外键检查失败');
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('续约字段清理完整性检查失败');
    db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1; INSERT INTO schema_version VALUES(30); COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
