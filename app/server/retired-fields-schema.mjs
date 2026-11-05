import {createHash} from 'node:crypto';

export const RETIRED_FIELDS_24={customers:['level'],contracts:['accept_status']};
const archiveSource='schema24字段精简';
const hasLeadingIndex=(db,table,column)=>db.prepare(`PRAGMA index_list(${table})`).all().some(index=>!index.partial&&db.prepare('PRAGMA index_info("'+index.name.replaceAll('"','""')+'")').all().some(part=>part.seqno===0&&part.name===column));

// Retired values remain immutable source evidence, never inferred into the
// independently maintained manual_level or project_status fields.
export function migrateRetiredFields(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=24').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const at=new Date().toISOString();
    for(const [table,fields] of Object.entries(RETIRED_FIELDS_24))for(const field of fields){
      const entity=table==='customers'?'customer':'contract';
      for(const row of db.prepare(`SELECT id,${field} FROM ${table} WHERE ${field} IS NOT NULL ORDER BY id`).all()){
        const payload=JSON.stringify(row),sourceId=String(row.id)+':'+field;
        const fingerprint=createHash('sha256').update(`schema24:${table}:${sourceId}:${payload}`).digest('hex');
        const existing=db.prepare('SELECT source,source_table,source_id,entity,entity_id,payload,status FROM source_records WHERE fingerprint=?').get(fingerprint);
        const expected={source:archiveSource,source_table:table,source_id:sourceId,entity,entity_id:row.id,payload,status:'archived'};
        if(existing&&Object.entries(expected).some(([key,value])=>existing[key]!==value))throw new Error('字段精简历史证据冲突，未覆盖原资料');
        const sameSource=db.prepare('SELECT fingerprint,payload FROM source_records WHERE source=? AND source_table=? AND source_id=?').all(archiveSource,table,sourceId);
        if(sameSource.some(item=>item.fingerprint!==fingerprint||item.payload!==payload))throw new Error('字段精简已有来源与当前旧值不一致，未删除旧字段');
        if(!existing)db.prepare('INSERT INTO source_records(source,source_table,source_id,entity,entity_id,payload,source_file,sheet_name,row_number,imported_at,fingerprint,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(archiveSource,table,sourceId,entity,row.id,payload,'schema23数据库原字段',table,row.id,at,fingerprint,'archived',field==='level'?'旧客户等级已退役，原值完整保留；不推定手动客户等级':'旧四态验收状态已退役，原值完整保留；不推定七态项目状态');
      }
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${field}`);
    }
    for(const [table,name] of [['opportunities','opportunities_customer'],['contracts','contracts_customer']])if(!hasLeadingIndex(db,table,'customer_id'))db.exec(`CREATE INDEX ${name} ON ${table}(customer_id)`);
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('字段精简外键检查失败');
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('字段精简完整性检查失败');
    db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1; INSERT INTO schema_version VALUES(24); COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
