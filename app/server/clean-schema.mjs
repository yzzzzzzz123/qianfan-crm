import {createHash} from 'node:crypto';

export const RETIRED_TABLES=['capture_drafts','change_requests','sync_runs'];
export const RETIRED_OPPORTUNITY_FIELDS=['ppl_stage','mirror','synced_at','ppl_amount','product_type','source','nature','deal_type','est_margin','products','man_days','source_sales'];

// Keep historical values as source evidence, then remove retired runtime structures.
export function migrateCleanBusiness(db){
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=10').get())return;
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try{
    for(const table of ['customers','opportunities','contracts']){
      if(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE owner_id IS NULL`).get().n)throw new Error(`${table}存在未分配负责人，需人工核对后升级；没有删除或猜填任何记录`);
    }
    const at=new Date().toISOString();
    const preserve=(table,row,entity=null,entityId=null)=>{
      const payload=JSON.stringify(row),fingerprint=createHash('sha256').update('schema10:'+table+':'+row.id+':'+payload).digest('hex');
      db.prepare('INSERT OR IGNORE INTO source_records(source,source_table,source_id,entity,entity_id,payload,source_file,sheet_name,row_number,imported_at,fingerprint,status,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('schema9历史迁移',table,String(row.id),entity,entityId,payload,'schema9数据库迁移',table,row.id,at,fingerprint,'archived','旧结构已停用；原始内容保留供追溯');
    };
    for(const row of db.prepare('SELECT id,ppl_id FROM customers WHERE ppl_id IS NOT NULL').all())preserve('customers',row,'customer',row.id);
    for(const row of db.prepare('SELECT id,'+RETIRED_OPPORTUNITY_FIELDS.join(',')+' FROM opportunities').all()){
      if(RETIRED_OPPORTUNITY_FIELDS.some(k=>row[k]!==null&&row[k]!==''&&row[k]!==0))preserve('opportunities',row,'opportunity',row.id);
    }
    for(const row of db.prepare("SELECT id,source_sales,quote_file FROM contracts WHERE source_sales!='' OR quote_file!=''").all())preserve('contracts',row,'contract',row.id);
    for(const table of RETIRED_TABLES)for(const row of db.prepare('SELECT * FROM '+table).all())preserve(table,row);
    const triggers=db.prepare("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger'").all();
    for(const trigger of triggers)db.exec('DROP TRIGGER "'+trigger.name.replaceAll('"','""')+'"');
    for(const table of ['customers','opportunities','contracts']){
      const original=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
      const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").all(table);
      const cols=db.prepare(`PRAGMA table_info(${table})`).all().map(c=>'"'+c.name+'"').join(',');
      const ddl=original.replace(new RegExp('CREATE TABLE\\s+"?'+table+'"?','i'),'CREATE TABLE '+table+'_v10').replace(/owner_id INTEGER(?! NOT NULL)/i,'owner_id INTEGER NOT NULL');
      db.exec(ddl);db.exec(`INSERT INTO ${table}_v10 (${cols}) SELECT ${cols} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_v10 RENAME TO ${table};`);
      for(const index of indexes)db.exec(index.sql);
    }
    db.exec('DROP INDEX IF EXISTS opportunity_ppl; DROP INDEX IF EXISTS customer_ppl; ALTER TABLE opportunities RENAME COLUMN ppl_ref TO reference; CREATE UNIQUE INDEX opportunities_reference ON opportunities(reference) WHERE reference IS NOT NULL; ALTER TABLE customers DROP COLUMN ppl_id;');
    for(const column of RETIRED_OPPORTUNITY_FIELDS)db.exec('ALTER TABLE opportunities DROP COLUMN '+column);
    db.exec("ALTER TABLE contracts DROP COLUMN source_sales; ALTER TABLE contracts DROP COLUMN quote_file; ALTER TABLE users DROP COLUMN password; DELETE FROM sessions WHERE auth_method='password';");
    const sessionSql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql;
    const sessionIndexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='sessions' AND sql IS NOT NULL").all();
    db.exec(sessionSql.replace(/CREATE TABLE\s+"?sessions"?/i,'CREATE TABLE sessions_v10').replace("DEFAULT 'password'","DEFAULT 'dingtalk'"));
    db.exec('INSERT INTO sessions_v10 SELECT * FROM sessions; DROP TABLE sessions; ALTER TABLE sessions_v10 RENAME TO sessions;');
    for(const index of sessionIndexes)db.exec(index.sql);
    for(const table of RETIRED_TABLES)db.exec('DROP TABLE '+table);
    for(const trigger of triggers)if(!RETIRED_TABLES.includes(trigger.tbl_name)&&!/^opportunities_production_/.test(trigger.name))db.exec(trigger.sql.replace("('password','demo','dingtalk')","('demo','dingtalk')"));
    const condition="NEW.stage NOT IN ('线索','需求','方案','商务','赢单','输单','搁置') OR NEW.initial_amount<0";
    for(const operation of ['INSERT','UPDATE'])db.exec(`CREATE TRIGGER opportunities_production_${operation.toLowerCase()} BEFORE ${operation} ON opportunities WHEN ${condition} BEGIN SELECT RAISE(ABORT,'CRM field integrity violation: opportunities'); END;`);
    for(const operation of ['INSERT','UPDATE'])db.exec(`CREATE TRIGGER opportunities_required_classification_${operation.toLowerCase()} BEFORE ${operation} ON opportunities WHEN NEW.sale_type IS NULL OR NEW.order_type IS NULL BEGIN SELECT RAISE(ABORT,'CRM opportunity sale_type and order_type are required'); END;`);
    const rules=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='rules'").get().value);delete rules.mirror_mode;
    db.prepare("UPDATE settings SET value=? WHERE key='rules'").run(JSON.stringify(rules));
    const integrations=db.prepare("SELECT value FROM settings WHERE key='integrations'").get();
    if(integrations){const value=JSON.parse(integrations.value);delete value.ppl;db.prepare("UPDATE settings SET value=? WHERE key='integrations'").run(JSON.stringify(value));}
    db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('清理旧业务结构后外键检查失败');
    db.exec('INSERT INTO schema_version VALUES(10); COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  finally{db.exec('PRAGMA foreign_keys=ON');}
}
