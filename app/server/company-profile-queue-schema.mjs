// Pure SQLite triggers deliberately avoid application-defined functions so that
// direct SQL imports also enqueue. The worker verifies the authoritative SHA256
// identity before it resumes a checkpoint or saves a provider result.
export function sqlCompanyIdentity(prefix='') {
  const tidy=column=>["' '","'　'",'char(9)','char(10)','char(13)','char(160)','char(8203)','char(8204)','char(8205)','char(8288)','char(65279)'].reduce((value,space)=>`replace(${value},${space},'')`,`coalesce(${prefix}${column},'')`);
  const name=["'（'","'）'","'('","')'"].reduce((value,part)=>`replace(${value},${part},'')`,tidy('name'));
  return `json_array(lower(${name}),upper(${tidy('credit_code')}))`;
}

export function migrateCompanyProfileQueue(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=25').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE customer_profiles_v25(
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
      state TEXT NOT NULL CHECK(state IN('not_configured','not_read','ready','partial','not_found','mismatch','failed')),
      provider TEXT NOT NULL DEFAULT '',source_url TEXT NOT NULL DEFAULT '',details TEXT NOT NULL DEFAULT '{}',reason TEXT NOT NULL DEFAULT '',
      checked_at TEXT,identity_fingerprint TEXT NOT NULL);
      INSERT INTO customer_profiles_v25 SELECT * FROM customer_profiles;
      DROP TABLE customer_profiles;ALTER TABLE customer_profiles_v25 RENAME TO customer_profiles;
      CREATE TABLE company_profile_jobs(
        customer_id INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
        identity_key TEXT NOT NULL,identity_version INTEGER NOT NULL DEFAULT 1 CHECK(identity_version>0),identity_fingerprint TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','complete','partial','mismatch','not_found','failed','waiting_quota')),
        checkpoint TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(checkpoint)),attempts INTEGER NOT NULL DEFAULT 0,retry_count INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 100),
        next_retry_at TEXT,lease_token TEXT,lease_until TEXT,error_code TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL,finished_at TEXT);
      CREATE INDEX company_profile_jobs_due ON company_profile_jobs(status,next_retry_at,customer_id);
      CREATE TABLE company_profile_queue_control(
        id INTEGER PRIMARY KEY CHECK(id=1),paused_until TEXT,pause_reason TEXT NOT NULL DEFAULT '',lease_token TEXT,lease_until TEXT,updated_at TEXT NOT NULL);
      INSERT INTO company_profile_queue_control(id,updated_at) VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      INSERT INTO company_profile_jobs(customer_id,identity_key,created_at,updated_at)
        SELECT id,${sqlCompanyIdentity()},strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM customers;
      CREATE TRIGGER company_profile_customer_insert AFTER INSERT ON customers BEGIN
        INSERT INTO company_profile_jobs(customer_id,identity_key,priority,created_at,updated_at)
        VALUES(NEW.id,${sqlCompanyIdentity('NEW.')},50,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER company_profile_customer_identity AFTER UPDATE OF name,credit_code ON customers
      WHEN ${sqlCompanyIdentity('OLD.')}!=${sqlCompanyIdentity('NEW.')} BEGIN
        UPDATE company_profile_jobs SET identity_key=${sqlCompanyIdentity('NEW.')},identity_version=identity_version+1,
          status='pending',priority=MAX(priority,50),attempts=0,retry_count=0,next_retry_at=NULL,lease_token=NULL,lease_until=NULL,error_code='',reason='',finished_at=NULL,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE customer_id=NEW.id;
      END;
      CREATE TRIGGER revision_customer_profiles_insert AFTER INSERT ON customer_profiles BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
      CREATE TRIGGER revision_customer_profiles_update AFTER UPDATE ON customer_profiles BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
      CREATE TRIGGER revision_customer_profiles_delete AFTER DELETE ON customer_profiles BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
      INSERT INTO schema_version VALUES(25);COMMIT;`);
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export function migrateManualCompanyProfileQueue(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=26').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE company_profile_jobs ADD COLUMN manual_only INTEGER NOT NULL DEFAULT 0 CHECK(manual_only IN(0,1));
      UPDATE company_profile_jobs SET manual_only=1 WHERE error_code='MANUAL_REQUIRED';
      DROP TRIGGER company_profile_customer_identity;
      CREATE TRIGGER company_profile_customer_identity AFTER UPDATE OF name,credit_code ON customers
      WHEN ${sqlCompanyIdentity('OLD.')}!=${sqlCompanyIdentity('NEW.')} BEGIN
        UPDATE company_profile_jobs SET identity_key=${sqlCompanyIdentity('NEW.')},identity_version=identity_version+1,
          status=CASE WHEN manual_only=1 THEN 'failed' ELSE 'pending' END,priority=MAX(priority,50),attempts=0,retry_count=0,
          next_retry_at=NULL,lease_token=NULL,lease_until=NULL,
          error_code=CASE WHEN manual_only=1 THEN 'MANUAL_REQUIRED' ELSE '' END,
          reason=CASE WHEN manual_only=1 THEN '该客户的企业资料需手动查询' ELSE '' END,finished_at=NULL,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE customer_id=NEW.id;
      END;
      INSERT INTO schema_version VALUES(26);COMMIT;`);
  }catch(error){db.exec('ROLLBACK');throw error;}
}
