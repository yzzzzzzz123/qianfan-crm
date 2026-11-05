import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {migrateProduction} from '../../server/production-schema.mjs';
import {migrateAcceptance,migrateIntakeContext} from '../../server/acceptance-schema.mjs';

// Start from a frozen, genuine old structure. Never downgrade the current schema
// by deleting columns: that leaves newer constraints and cannot test migration.
export function legacyDatabase(filename,version=3) {
  if(![3,5,7].includes(version))throw new Error('Unsupported legacy fixture version');
  const db=new DatabaseSync(filename);
  try {
    db.exec(fs.readFileSync(new URL('../fixtures/schema-v3.sql',import.meta.url),'utf8'));
    db.exec(`
      INSERT INTO users(id,name,username,role,created_at,performance_enabled) VALUES
        (1,'迁移管理员','migration-admin','admin','2026-09-01T00:00:00.000Z',0),
        (2,'迁移销售','migration-sales','sales','2026-09-01T00:00:00.000Z',1);
      INSERT INTO customers(id,name,normalized,owner_id,created_at,updated_at) VALUES
        (1,'迁移客户有限公司','迁移客户有限公司',2,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
      INSERT INTO contacts(id,customer_id,name,phone) VALUES(1,1,'迁移联系人','010-55550001');
      INSERT INTO opportunities(id,name,customer_id,owner_id,stage,amount,product_type,stage_at,created_at,updated_at,initial_amount) VALUES
        (1,'迁移测试产品',1,2,'成交',100000,'标品','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z',100000);
      INSERT INTO activities(id,opportunity_id,user_id,source,activity_type,summary,activity_date,created_at) VALUES
        (1,1,2,'manual','电话','迁移前跟进','2026-09-01','2026-09-01T00:00:00.000Z');
      INSERT INTO activity_events(id,activity_id,opportunity_id,user_id,credited_user_id,source,activity_type,activity_date,summary,created_at) VALUES
        (1,1,1,2,2,'manual','电话','2026-09-01','迁移前跟进','2026-09-01T00:00:00.000Z');
      INSERT INTO contracts(id,opportunity_id,customer_id,owner_id,name,amount,sign_date,accept_status,created_at,contract_no) VALUES
        (1,1,1,2,'迁移测试合同',100000,'2026-09-01','已验收','2026-09-01T00:00:00.000Z','MIGRATION-001');
      INSERT INTO contract_items(id,contract_id,name,kind,amount,rate,margin) VALUES(1,1,'迁移测试产品','标品',100000,0.45,45000);
      INSERT INTO payments(id,contract_id,amount,status,pay_date,created_at) VALUES(1,1,50000,'已到账','2026-09-02','2026-09-02T00:00:00.000Z');
      INSERT INTO targets(user_id,quarter,amount) VALUES(2,'2026Q3',200000);
      INSERT INTO sessions(token,user_id,csrf,expires,auth_method) VALUES('legacy-ding-session',2,'synthetic-csrf',4102444800000,'dingtalk');
      INSERT INTO ding_identities(user_id,union_id) VALUES(2,'synthetic-migration-union-id');
      INSERT INTO commission_batches(id,sales_id,kind,period,base,rate,amount,status,snapshot,created_at,confirmed_by) VALUES
        (1,2,'personal','2026Q3',45000,0.03,1350,'confirmed','{"legacy":true}','2026-09-30T00:00:00.000Z',1);
      INSERT INTO commission_lines(id,batch_id,contract_id,item_id,base,rebate_rate,rate,amount) VALUES(1,1,1,1,45000,0.45,0.03,1350);
      INSERT INTO performance_reviews(user_id,month,adjustment,reason,status,snapshot,reviewed_by,updated_at) VALUES
        (2,'2026-09',3,'旧快照','confirmed','{"score":80}',1,'2026-09-30T00:00:00.000Z');
    `);
    if(version>=5){
      db.exec('ALTER TABLE users ADD COLUMN business_member INTEGER NOT NULL DEFAULT 1 CHECK(business_member IN(0,1)); INSERT INTO schema_version VALUES(4)');
      migrateProduction(db);
    }
    if(version>=7){migrateAcceptance(db);migrateIntakeContext(db);}
    return db;
  } catch(error) {db.close();throw error;}
}
