// Real CRM ownership: additive, atomic migration. Historical evidence stays intact.
export function migrateRealBusiness(db) {
  if (db.prepare('SELECT 1 FROM schema_version WHERE version=9').get()) return;
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    const triggers=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all();
    for(const trigger of triggers)db.exec('DROP TRIGGER "'+trigger.name.replaceAll('"','""')+'"');
    // Historical ownership may be unknown or belong to a non-business login identity.
    // Preserve the original salesperson separately and leave business ownership unassigned.
    const rebuild=(table,transform)=>{
      const original=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql;
      const auxiliary=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type='index' AND sql IS NOT NULL").all(table);
      const cols=db.prepare(`PRAGMA table_info(${table})`).all().map(c=>'"'+c.name+'"').join(',');
      db.exec(transform(original.replace(new RegExp('CREATE TABLE\\s+"?'+table+'"?','i'),'CREATE TABLE '+table+'_v9')));
      db.exec(`INSERT INTO ${table}_v9 (${cols}) SELECT ${cols} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_v9 RENAME TO ${table};`);
      for(const row of auxiliary)db.exec(row.sql);
    };
    for(const table of ['customers','opportunities','contracts'])rebuild(table,sql=>{
      sql=sql.replace(/owner_id INTEGER NOT NULL/i,'owner_id INTEGER');
      if(table==='opportunities')sql=sql.replace(/product_type TEXT NOT NULL/i,'product_type TEXT').replace(/source TEXT NOT NULL DEFAULT '自建'/i,'source TEXT').replace(/nature TEXT NOT NULL DEFAULT '新签'/i,'nature TEXT').replace(/deal_type TEXT NOT NULL DEFAULT 'new'/i,'deal_type TEXT').replace(/est_margin INTEGER NOT NULL DEFAULT 0/i,'est_margin INTEGER');
      if(table==='contracts')sql=sql.replace(/accept_status TEXT NOT NULL DEFAULT '待交付'/i,'accept_status TEXT');
      return sql;
    });
    rebuild('contract_items',sql=>sql.replace("kind IN('标品','实施')","kind IN('标品','实施','定开','交付','运维','未分类')").replace(/rate REAL NOT NULL/i,'rate REAL').replace(/margin INTEGER NOT NULL/i,'margin INTEGER'));
    const checks={
      opportunities:"NEW.stage NOT IN ('线索','需求','方案','商务','赢单','输单','搁置') OR (NEW.deal_type IS NOT NULL AND NEW.deal_type NOT IN ('new','renewal','collection')) OR NEW.mirror NOT IN (0,1) OR NEW.man_days<0 OR NEW.man_days>1000000 OR (NEW.est_margin IS NOT NULL AND (NEW.est_margin<0 OR typeof(NEW.est_margin)<>'integer')) OR NEW.initial_amount<0",
      contract_items:"NEW.man_days<0 OR NEW.man_days>1000000 OR NEW.margin>NEW.amount OR typeof(NEW.amount)<>'integer' OR (NEW.margin IS NOT NULL AND typeof(NEW.margin)<>'integer')",
    };
    db.exec(`
      ALTER TABLE opportunities ADD COLUMN source_sales TEXT NOT NULL DEFAULT '';
      ALTER TABLE contracts ADD COLUMN source_sales TEXT NOT NULL DEFAULT '';
      ALTER TABLE contracts ADD COLUMN sale_type TEXT CHECK(sale_type IS NULL OR sale_type IN('新签自建','新签分发','续费','增购'));
      ALTER TABLE contracts ADD COLUMN order_type TEXT CHECK(order_type IS NULL OR order_type IN('代销','经销','千帆'));
      ALTER TABLE opportunities ADD COLUMN product_amount INTEGER CHECK(product_amount IS NULL OR typeof(product_amount)='integer' AND product_amount>=0);
      ALTER TABLE opportunities ADD COLUMN sale_type TEXT CHECK(sale_type IS NULL OR sale_type IN('新签自建','新签分发','续费','增购'));
      ALTER TABLE opportunities ADD COLUMN order_type TEXT CHECK(order_type IS NULL OR order_type IN('代销','经销','千帆'));
      ALTER TABLE contracts ADD COLUMN lifecycle TEXT NOT NULL DEFAULT '历史登记' CHECK(lifecycle IN('草稿','已归档','历史登记'));
      ALTER TABLE contracts ADD COLUMN archived_at TEXT;
      ALTER TABLE contracts ADD COLUMN archived_by INTEGER REFERENCES users(id);
      ALTER TABLE contracts ADD COLUMN archive_attachment_id INTEGER REFERENCES attachments(id);
      ALTER TABLE contracts ADD COLUMN commission_policy TEXT NOT NULL DEFAULT 'legacy' CHECK(commission_policy IN('legacy','pending'));
      ALTER TABLE quotes ADD COLUMN items TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(items));
      ALTER TABLE quotes ADD COLUMN list_amount INTEGER CHECK(list_amount IS NULL OR typeof(list_amount)='integer' AND list_amount>=0);
      ALTER TABLE quotes ADD COLUMN discount_amount INTEGER CHECK(discount_amount IS NULL OR typeof(discount_amount)='integer' AND discount_amount>=0);
      CREATE TABLE attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,entity TEXT NOT NULL,entity_id INTEGER NOT NULL,
        filename TEXT NOT NULL,mime_type TEXT NOT NULL,size INTEGER NOT NULL CHECK(size>0),sha256 TEXT NOT NULL,
        content BLOB NOT NULL CHECK(length(content)>0),source_path TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,created_by INTEGER REFERENCES users(id),UNIQUE(entity,entity_id,sha256));
      CREATE TABLE source_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,source TEXT NOT NULL,source_table TEXT NOT NULL DEFAULT '',source_id TEXT NOT NULL DEFAULT '',
        entity TEXT,entity_id INTEGER,payload TEXT NOT NULL CHECK(json_valid(payload)),source_file TEXT NOT NULL,
        sheet_name TEXT NOT NULL DEFAULT '',row_number INTEGER,imported_at TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'imported',reason TEXT NOT NULL DEFAULT '');
      CREATE INDEX source_records_entity ON source_records(entity,entity_id);
      CREATE INDEX source_records_source ON source_records(source,source_table,source_id);
      CREATE INDEX attachments_entity ON attachments(entity,entity_id);
      CREATE INDEX contracts_lifecycle ON contracts(lifecycle,sign_date);
    `);
    const existing = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='rules'").get().value);
    const stageMap={'初步接触':'线索','需求确认':'需求','方案沟通':'方案','报价':'方案','POC 试用':'商务','商务谈判':'商务','成交':'赢单','流失':'输单'};
    for(const [before,after] of Object.entries(stageMap))db.prepare('UPDATE opportunities SET stage=? WHERE stage=?').run(after,before);
    for(const trigger of triggers)if(!/^(opportunities|contract_items)_production_/.test(trigger.name))db.exec(trigger.sql);
    for(const [table,condition]of Object.entries(checks))for(const operation of ['INSERT','UPDATE'])db.exec(`CREATE TRIGGER ${table}_production_${operation.toLowerCase()} BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'CRM field integrity violation: ${table}'); END;`);
    const thresholds={线索:existing.thresholds?.线索||5,需求:existing.thresholds?.需求确认||3,方案:existing.thresholds?.方案沟通||5,商务:existing.thresholds?.商务谈判||3,搁置:30};
    const sop={线索:'明确客户需求与负责人',需求:'确认需求范围与预算',方案:'确认产品与实施方案',商务:'核对报价、付款及签约安排',赢单:'跟进履约与回款',输单:'保留流失原因',搁置:'记录搁置原因和重新跟进时间'};
    db.prepare("UPDATE settings SET value=? WHERE key='rules'").run(JSON.stringify({...existing,thresholds,sop,mirror_mode:false,new_commission_policy:'pending'}));
    for(const table of ['attachments','source_records']) for(const op of ['INSERT','UPDATE','DELETE'])
      db.exec(`CREATE TRIGGER ${table}_revision_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;`);
    db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1');
    if(db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('真实业务结构升级外键检查失败');
    db.exec('INSERT INTO schema_version VALUES(9); COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
  finally {db.exec('PRAGMA foreign_keys=ON');}
}
