import { SALES_POLICY } from './sales-policy.mjs';

export function migrateMeetingPolicy(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=14').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const lineObjects=db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='commission_lines' AND type IN('index','trigger') AND sql IS NOT NULL").all();
    db.exec(`ALTER TABLE customers ADD COLUMN manual_level TEXT;
      ALTER TABLE payments ADD COLUMN product_amount INTEGER CHECK(product_amount IS NULL OR typeof(product_amount)='integer' AND product_amount>=0 AND product_amount<=amount);
      CREATE TABLE commission_lines_v14 (id INTEGER PRIMARY KEY AUTOINCREMENT,batch_id INTEGER NOT NULL REFERENCES commission_batches(id),contract_id INTEGER NOT NULL REFERENCES contracts(id),item_id INTEGER NOT NULL REFERENCES contract_items(id),base INTEGER NOT NULL,rebate_rate REAL,rate REAL NOT NULL,amount INTEGER NOT NULL,component TEXT NOT NULL DEFAULT 'legacy');
      INSERT INTO commission_lines_v14(id,batch_id,contract_id,item_id,base,rebate_rate,rate,amount) SELECT id,batch_id,contract_id,item_id,base,rebate_rate,rate,amount FROM commission_lines;
      DROP TABLE commission_lines;
      ALTER TABLE commission_lines_v14 RENAME TO commission_lines;
      ALTER TABLE performance_reviews ADD COLUMN final_score REAL CHECK(final_score IS NULL OR final_score>=0 AND final_score<=100);`);
    for(const {sql} of lineObjects)db.exec(sql);
    const rules=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='rules'").get().value);
    rules.customer_levels=['A','B','C'];
    rules.commission.sales_policy=structuredClone(SALES_POLICY);
    db.prepare("UPDATE settings SET value=? WHERE key='rules'").run(JSON.stringify(rules));
    db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('会议规则升级引用校验失败');
    db.exec('INSERT INTO schema_version VALUES(14); COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}

// The supplied FY26 SOP is authoritative for grade thresholds and salary factors.
// Confirmed monthly reviews already carry their immutable original snapshots.
export function migrateSopPerformance(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=15').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const rules=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='rules'").get().value);
    rules.performance.grades=[{min:85,grade:'A',factor:1},{min:75,grade:'B',factor:.9},{min:60,grade:'C',factor:.6},{min:0,grade:'D',factor:.4}];
    if(rules.commission.sales_policy&&typeof rules.commission.sales_policy.service_scope_confirmed!=='boolean')rules.commission.sales_policy.service_scope_confirmed=false;
    db.prepare("UPDATE settings SET value=? WHERE key='rules'").run(JSON.stringify(rules));
    db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1');
    db.exec('INSERT INTO schema_version VALUES(15); COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

// User confirmed the two overwritten D-grade cells as 5% and 12%.
// Fill only unresolved cells; preserve administrator edits and confirmed snapshots.
export function migrateConfirmedProductRates(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=16').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const rules=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='rules'").get().value);
    let changed=false;
    for(const [min,rate] of [[2000000,.05],[16000000,.12]]) {
      const band=rules.commission.sales_policy?.product.find(b=>b.min===min);
      if(band&&band.rates.D===null){band.rates.D=rate;changed=true;}
    }
    if(changed){
      db.prepare("UPDATE settings SET value=? WHERE key='rules'").run(JSON.stringify(rules));
      db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1');
    }
    db.exec('INSERT INTO schema_version VALUES(16); COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
