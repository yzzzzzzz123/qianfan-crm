// Transactional upgrade: preserve business IDs, sessions and financial snapshots.
export function migrateAcceptance(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=6').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE opportunities ADD COLUMN ppl_amount INTEGER CHECK(ppl_amount IS NULL OR typeof(ppl_amount)='integer' AND ppl_amount>=0);
      CREATE TABLE ai_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id),source_hash TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN('draft','confirmed','cancelled')),
      summary TEXT NOT NULL,questions TEXT NOT NULL CHECK(json_valid(questions)),operations TEXT NOT NULL CHECK(json_valid(operations)),
      errors TEXT NOT NULL CHECK(json_valid(errors)),model TEXT NOT NULL,usage TEXT NOT NULL CHECK(json_valid(usage)),
      source_text TEXT NOT NULL DEFAULT '',base_revision INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,confirmed_at TEXT,result TEXT CHECK(result IS NULL OR json_valid(result)),UNIQUE(user_id,source_hash));
      CREATE INDEX ai_batches_user_state ON ai_import_batches(user_id,state,id);
      CREATE TABLE ai_uploads(id INTEGER PRIMARY KEY AUTOINCREMENT,batch_id INTEGER NOT NULL REFERENCES ai_import_batches(id),
        filename TEXT NOT NULL,sha256 TEXT NOT NULL,content BLOB NOT NULL CHECK(length(content)>0 AND length(content)<=10485760));
      CREATE INDEX ai_uploads_batch ON ai_uploads(batch_id);
      CREATE TABLE workspace_revision(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
      INSERT INTO workspace_revision VALUES(1,0);
      CREATE INDEX payments_status_date ON payments(status,pay_date);
      CREATE INDEX targets_quarter ON targets(quarter,user_id);
    `);
    const checks={
      opportunities: "typeof(NEW.amount)<>'integer' OR (NEW.initial_amount IS NOT NULL AND typeof(NEW.initial_amount)<>'integer') OR EXISTS(SELECT 1 FROM contracts c WHERE c.opportunity_id=NEW.id AND c.customer_id!=NEW.customer_id)",
      contracts: "typeof(NEW.amount)<>'integer' OR typeof(NEW.recurring_amount)<>'integer' OR NEW.amount<(SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.contract_id=NEW.id AND p.status='已到账')",
      targets: "typeof(NEW.amount)<>'integer' OR NEW.quarter NOT GLOB '[0-9][0-9][0-9][0-9]Q[1-4]' OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=NEW.user_id AND u.role='sales' AND u.business_member=1 AND u.developer_admin=0)",
      activity_events: "NOT EXISTS(SELECT 1 FROM activities a WHERE a.id=NEW.activity_id AND a.opportunity_id=NEW.opportunity_id AND a.user_id=NEW.user_id)",
      payments: "NEW.status='已到账' AND NEW.amount+(SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.contract_id=NEW.contract_id AND p.status='已到账' AND p.id!=NEW.id)>(SELECT c.amount FROM contracts c WHERE c.id=NEW.contract_id)",
      sessions: "NEW.auth_method NOT IN ('password','demo','dingtalk') OR typeof(NEW.expires)<>'integer'",
    };
    for(const [table,condition] of Object.entries(checks)) {
      const existing=condition.replaceAll('NEW.','existing.');
      const invalid=db.prepare(`SELECT COUNT(*) n FROM ${table} existing WHERE ${existing}`).get().n;
      if(invalid)throw new Error(`数据库升级前需核对${table}：${invalid}条记录不满足业务约束；本次升级已回滚`);
      for(const operation of ['INSERT','UPDATE']) db.exec(`CREATE TRIGGER ${table}_acceptance_${operation.toLowerCase()} BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'CRM relationship or amount integrity violation: ${table}'); END;`);
    }
    const tracked=['users','ding_identities','customers','contacts','opportunities','activities','activity_events','quotes','contracts','contract_items','payments','targets','settings','commission_batches','commission_lines','performance_reviews','change_requests','sync_runs'];
    for(const table of tracked) for(const op of ['INSERT','UPDATE','DELETE']) db.exec(`CREATE TRIGGER ${table}_revision_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;`);
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('升级后外键检查失败');
    db.exec('INSERT INTO schema_version VALUES(6); COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
export function migrateIntakeContext(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=7').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE ai_import_batches ADD COLUMN source_context TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(source_context));
      ALTER TABLE ai_import_batches ADD COLUMN source_role TEXT NOT NULL DEFAULT 'sales' CHECK(source_role IN('admin','sales','pm'));
      UPDATE ai_import_batches SET source_role=(SELECT role FROM users WHERE users.id=ai_import_batches.user_id);
      INSERT INTO schema_version VALUES(7); COMMIT;`);
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
