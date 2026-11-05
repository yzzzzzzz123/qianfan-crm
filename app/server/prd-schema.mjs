// Additive, transactional upgrade from the handover snapshot. Keep original IDs.
export function migratePrd(db) {
  if (db.prepare("SELECT 1 FROM schema_version WHERE version=2").get()) return;
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE users_v2 (id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN('admin','sales','pm')), password TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), created_at TEXT NOT NULL, ding_user_id TEXT, performance_enabled INTEGER NOT NULL DEFAULT 1);
      INSERT INTO users_v2(id,name,username,role,password,active,created_at,performance_enabled) SELECT id,name,username,role,password,active,created_at,CASE WHEN role='sales' THEN 1 ELSE 0 END FROM users;
      DROP TABLE users;
      ALTER TABLE users_v2 RENAME TO users;
      CREATE UNIQUE INDEX users_ding ON users(ding_user_id) WHERE ding_user_id IS NOT NULL AND ding_user_id!='';
      CREATE TABLE contacts_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id), name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '使用人' CHECK(role IN('决策人','影响者','使用人','把关人','我方PM')), attitude TEXT NOT NULL DEFAULT '中立' CHECK(attitude IN('支持','中立','反对')), note TEXT NOT NULL DEFAULT '', wechat TEXT NOT NULL DEFAULT '', dingtalk TEXT NOT NULL DEFAULT '', last_contact TEXT);
      INSERT INTO contacts_v2(id,customer_id,name,title,phone,role,attitude,note) SELECT * FROM contacts;
      DROP TABLE contacts;
      ALTER TABLE contacts_v2 RENAME TO contacts;
      CREATE TABLE contracts_v2 (id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_id INTEGER REFERENCES opportunities(id), customer_id INTEGER NOT NULL REFERENCES customers(id), owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), sign_date TEXT NOT NULL, valid_until TEXT, scope TEXT NOT NULL DEFAULT '', accept_status TEXT NOT NULL DEFAULT '待交付' CHECK(accept_status IN('待交付','交付中','待验收','已验收')), created_at TEXT NOT NULL, contract_no TEXT, recurring_amount INTEGER NOT NULL DEFAULT 0, quote_file TEXT NOT NULL DEFAULT '', auto_renew INTEGER NOT NULL DEFAULT 0, collaborator_pm INTEGER REFERENCES users(id));
      INSERT INTO contracts_v2(id,opportunity_id,customer_id,owner_id,name,amount,sign_date,valid_until,scope,accept_status,created_at) SELECT * FROM contracts;
      DROP TABLE contracts;
      ALTER TABLE contracts_v2 RENAME TO contracts;
      CREATE UNIQUE INDEX contracts_number ON contracts(contract_no) WHERE contract_no IS NOT NULL;
      CREATE INDEX contracts_owner ON contracts(owner_id,sign_date);
      ALTER TABLE customers ADD COLUMN parent_company TEXT NOT NULL DEFAULT '';
      ALTER TABLE customers ADD COLUMN group_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE customers ADD COLUMN tags TEXT NOT NULL DEFAULT '';
      ALTER TABLE customers ADD COLUMN compliance_flag TEXT NOT NULL DEFAULT '';
      ALTER TABLE customers ADD COLUMN ppl_id TEXT;
      ALTER TABLE opportunities ADD COLUMN ppl_ref TEXT;
      ALTER TABLE opportunities ADD COLUMN ppl_stage TEXT;
      ALTER TABLE opportunities ADD COLUMN mirror INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE opportunities ADD COLUMN deal_type TEXT NOT NULL DEFAULT 'new';
      ALTER TABLE opportunities ADD COLUMN products TEXT NOT NULL DEFAULT '';
      ALTER TABLE opportunities ADD COLUMN man_days REAL NOT NULL DEFAULT 0;
      ALTER TABLE opportunities ADD COLUMN est_margin INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE opportunities ADD COLUMN initial_amount INTEGER;
      ALTER TABLE opportunities ADD COLUMN collaborator_pm INTEGER REFERENCES users(id);
      ALTER TABLE opportunities ADD COLUMN synced_at TEXT;
      CREATE UNIQUE INDEX opportunity_ppl ON opportunities(ppl_ref) WHERE ppl_ref IS NOT NULL;
      CREATE UNIQUE INDEX customer_ppl ON customers(ppl_id) WHERE ppl_id IS NOT NULL;
      ALTER TABLE contract_items ADD COLUMN man_days REAL NOT NULL DEFAULT 0;
      ALTER TABLE payments ADD COLUMN checkpoint_date TEXT;
      CREATE TABLE customer_collaborators (customer_id INTEGER NOT NULL REFERENCES customers(id), user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(customer_id,user_id));
      CREATE TABLE activity_events (id INTEGER PRIMARY KEY AUTOINCREMENT, activity_id INTEGER NOT NULL REFERENCES activities(id), opportunity_id INTEGER NOT NULL REFERENCES opportunities(id), user_id INTEGER NOT NULL REFERENCES users(id), credited_user_id INTEGER NOT NULL REFERENCES users(id), source TEXT NOT NULL, activity_type TEXT NOT NULL, activity_date TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO activity_events(activity_id,opportunity_id,user_id,credited_user_id,source,activity_type,activity_date,summary,created_at) SELECT a.id,a.opportunity_id,a.user_id,o.owner_id,a.source,a.activity_type,a.activity_date,a.summary,a.created_at FROM activities a JOIN opportunities o ON o.id=a.opportunity_id WHERE a.activity_type!='系统';
      UPDATE opportunities SET initial_amount=amount;
      CREATE TABLE stage_history (id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_id INTEGER NOT NULL REFERENCES opportunities(id), from_stage TEXT, to_stage TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE commission_batches (id INTEGER PRIMARY KEY AUTOINCREMENT, sales_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN('personal','management')), period TEXT NOT NULL, base INTEGER NOT NULL, rate REAL NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), status TEXT NOT NULL CHECK(status IN('confirmed','paid')), snapshot TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_by INTEGER NOT NULL REFERENCES users(id), paid_at TEXT, paid_note TEXT NOT NULL DEFAULT '');
      CREATE TABLE commission_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL REFERENCES commission_batches(id), contract_id INTEGER NOT NULL REFERENCES contracts(id), item_id INTEGER NOT NULL REFERENCES contract_items(id), base INTEGER NOT NULL, rebate_rate REAL NOT NULL, rate REAL NOT NULL, amount INTEGER NOT NULL);
      CREATE INDEX commission_period ON commission_batches(period,sales_id,kind);
      CREATE TABLE performance_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), month TEXT NOT NULL, adjustment REAL, reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN('draft','confirmed')), snapshot TEXT, reviewed_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL, UNIQUE(user_id,month));
      CREATE TABLE capture_drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), source TEXT NOT NULL, external_id TEXT, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'draft', created_at TEXT NOT NULL, confirmed_at TEXT, UNIQUE(source,external_id));
      CREATE TABLE change_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), entity TEXT NOT NULL, entity_id INTEGER, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, reviewed_at TEXT, reason TEXT NOT NULL DEFAULT '');
      CREATE TABLE sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, count INTEGER NOT NULL, created_at TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE daily_reports (day TEXT PRIMARY KEY, snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO schema_version VALUES(2);
    `);
    const old = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='rules'").get().value);
    const rules = {
      ...old, commission_visible: true, result_visible: true,
      commission: { period: "quarter", threshold: 20000000, low_rate: 0.03, high_rate: 0.05, manager_id: null, unlock_by_payment: false, standard_self_new: 0.45, standard_distributed_new: 0.35, standard_renewal: 0.25, implementation: 0.5 },
      performance: { process_weight: 70, result_weight: 30, cap: 50, meeting: 0.5, visit: 1, quote: 0.5, grades: [{min:90,grade:'A',factor:1.1},{min:75,grade:'B',factor:0.9},{min:60,grade:'C',factor:0.6},{min:0,grade:'D',factor:0.4}] },
      mirror_mode: true, attention_ratio: 0.8, inactivity_days: 30, contact_days: 30,
    };
    db.prepare("UPDATE settings SET value=? WHERE key='rules'").run(JSON.stringify(rules));
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  finally { db.exec("PRAGMA foreign_keys=ON"); }
  if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("CRM 数据升级后引用校验失败");
}
