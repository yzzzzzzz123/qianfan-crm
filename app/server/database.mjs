import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { migratePrd } from "./prd-schema.mjs";
import { migrateProduction } from "./production-schema.mjs";
import { migrateAcceptance, migrateIntakeContext } from "./acceptance-schema.mjs";
import {migrateIntakeTrace} from './intake-trace-schema.mjs';
import {migrateRealBusiness} from './real-schema.mjs';
import {migrateCleanBusiness} from './clean-schema.mjs';
import {migrateRequiredCash} from './cash-schema.mjs';
import {migrateQuoteTotals} from './quote-schema.mjs';
import {migrateHistoricalCustomerOwners} from './historical-customer-schema.mjs';
import {migrateMeetingPolicy,migrateSopPerformance,migrateConfirmedProductRates} from './meeting-schema.mjs';
import {migrateMinutes} from './minutes-schema.mjs';
import {migrateMinutesOrganizations} from './minutes-organizations-schema.mjs';
import {migrateVerifiedMinutesProfiles} from './minutes-profiles-schema.mjs';
import {migrateMinutesHistory} from './minutes-history-schema.mjs';
import {migrateContractWorkflow} from './contract-workflow-schema.mjs';
import {migrateCustomerProfile} from './customer-profile-schema.mjs';
import {migrateContractAnalysis} from './contract-analysis-schema.mjs';
import {migrateRetiredFields} from './retired-fields-schema.mjs';
import {migrateCompanyProfileQueue,migrateManualCompanyProfileQueue} from './company-profile-queue-schema.mjs';
import {migratePersonalMinutes} from './minutes-personal-schema.mjs';
import {migrateOpportunityArchive} from './opportunity-archive-schema.mjs';
import {migrateContractRetirement} from './contract-retirement-schema.mjs';
import {migrateRetiredRenewalFields} from './retired-renewal-schema.mjs';
import {migrateHistoricalOpportunityCustomers} from './historical-opportunity-customer-schema.mjs';

export function openDatabase(filename) {
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
    INSERT OR IGNORE INTO schema_version VALUES(1);
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','sales')), password TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE, short_name TEXT NOT NULL DEFAULT '', industry TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', level TEXT NOT NULL DEFAULT 'B' CHECK(level IN('A','B','C')), owner_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT '潜在' CHECK(status IN('潜在','成交','流失','冻结')), credit_code TEXT NOT NULL DEFAULT '', scale TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS customers_credit ON customers(credit_code) WHERE credit_code!='';
    CREATE TABLE IF NOT EXISTS contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id), name TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '使用人' CHECK(role IN('决策人','影响者','使用人','把关人')), attitude TEXT NOT NULL DEFAULT '中立' CHECK(attitude IN('支持','中立','反对')), note TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS opportunities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id), owner_id INTEGER NOT NULL REFERENCES users(id), stage TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0), product_type TEXT NOT NULL CHECK(product_type IN('标品','实施','混合')), source TEXT NOT NULL DEFAULT '自建' CHECK(source IN('自建','分发')), nature TEXT NOT NULL DEFAULT '新签' CHECK(nature IN('新签','续签')), next_action TEXT NOT NULL DEFAULT '', follow_date TEXT, expected_date TEXT, stage_at TEXT NOT NULL, lost_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_id INTEGER NOT NULL REFERENCES opportunities(id), user_id INTEGER NOT NULL REFERENCES users(id), source TEXT NOT NULL, activity_type TEXT NOT NULL, summary TEXT NOT NULL, action TEXT NOT NULL DEFAULT '', activity_date TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quotes (id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_id INTEGER NOT NULL REFERENCES opportunities(id), user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL CHECK(amount>0), valid_until TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contracts (id INTEGER PRIMARY KEY AUTOINCREMENT, opportunity_id INTEGER UNIQUE REFERENCES opportunities(id), customer_id INTEGER NOT NULL REFERENCES customers(id), owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), sign_date TEXT NOT NULL, valid_until TEXT, scope TEXT NOT NULL DEFAULT '', accept_status TEXT NOT NULL DEFAULT '待交付' CHECK(accept_status IN('待交付','交付中','待验收','已验收')), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS contract_items (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contracts(id), name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('标品','实施')), amount INTEGER NOT NULL CHECK(amount>0), rate REAL NOT NULL CHECK(rate>=0 AND rate<=1), margin INTEGER NOT NULL CHECK(margin>=0), payment_date TEXT, valid_until TEXT);
    CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, contract_id INTEGER NOT NULL REFERENCES contracts(id), amount INTEGER NOT NULL CHECK(amount>0), status TEXT NOT NULL CHECK(status IN('待到账','已到账','逾期')), pay_date TEXT, promise_date TEXT, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS targets (user_id INTEGER NOT NULL REFERENCES users(id), quarter TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=0), PRIMARY KEY(user_id,quarter));
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mutations (key TEXT PRIMARY KEY, hash TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS opportunities_owner ON opportunities(owner_id, stage);
    CREATE INDEX IF NOT EXISTS activities_opp ON activities(opportunity_id, activity_date);
    CREATE INDEX IF NOT EXISTS payments_contract ON payments(contract_id,status);
    CREATE INDEX IF NOT EXISTS contracts_owner ON contracts(owner_id,sign_date);
  `);
  const defaults = {
    thresholds: {
      线索: 5,
      初步接触: 4,
      需求确认: 3,
      方案沟通: 5,
      报价: 5,
      "POC 试用": 10,
      商务谈判: 3,
    },
    sop: {
      线索: "明确客户需求、决策链与预算窗口",
      初步接触: "建立关键人联系，约定深入沟通时间",
      需求确认: "梳理需求清单，请客户确认范围",
      方案沟通: "形成针对性方案，确认实施与验收条件",
      报价: "拆分标品与实施，说明有效期并约定回访",
      "POC 试用": "约定成功标准，记录试用反馈与验收结果",
      商务谈判: "确认采购流程、付款节点，先签合同再垫付实施费",
      成交: "明确交付范围、验收与回款节点",
      流失: "记录真实原因，保留后续接触线索",
    },
    commission_visible: false,
    result_visible: false,
  };
  db.prepare("INSERT OR IGNORE INTO settings VALUES(?,?)").run(
    "rules",
    JSON.stringify(defaults),
  );
  migratePrd(db);
  db.exec('CREATE TABLE IF NOT EXISTS ding_identities (user_id INTEGER PRIMARY KEY REFERENCES users(id), union_id TEXT NOT NULL UNIQUE);');
  if(!all(db,'PRAGMA table_info(users)').some(c=>c.name==='developer_admin'))db.exec('ALTER TABLE users ADD COLUMN developer_admin INTEGER NOT NULL DEFAULT 0');
  if(!all(db,'PRAGMA table_info(sessions)').some(c=>c.name==='auth_method'))db.exec("ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password'");
  db.exec('INSERT OR IGNORE INTO schema_version VALUES(3)');
  transaction(db,()=>{
    if(!all(db,'PRAGMA table_info(users)').some(c=>c.name==='business_member'))db.exec('ALTER TABLE users ADD COLUMN business_member INTEGER NOT NULL DEFAULT 1 CHECK(business_member IN(0,1))');
    run(db,'UPDATE users SET business_member=0,performance_enabled=0 WHERE developer_admin=1 AND (business_member!=0 OR performance_enabled!=0)');
    run(db,'INSERT OR IGNORE INTO schema_version VALUES(4)');
  });
  migrateProduction(db);
  migrateAcceptance(db);
  migrateIntakeContext(db);
  migrateIntakeTrace(db);
  migrateRealBusiness(db);
  migrateCleanBusiness(db);
  migrateRequiredCash(db);
  migrateQuoteTotals(db);
  migrateHistoricalCustomerOwners(db);
  migrateMeetingPolicy(db);
  migrateSopPerformance(db);
  migrateConfirmedProductRates(db);
  migrateMinutes(db);
  migrateMinutesOrganizations(db);
  migrateVerifiedMinutesProfiles(db);
  migrateMinutesHistory(db);
  migrateCustomerProfile(db);
  migrateContractWorkflow(db);
  migrateContractAnalysis(db);
  migrateRetiredFields(db);
  migrateCompanyProfileQueue(db);
  migrateManualCompanyProfileQueue(db);
  migratePersonalMinutes(db);
  migrateOpportunityArchive(db);
  migrateContractRetirement(db);
  migrateRetiredRenewalFields(db);
  migrateHistoricalOpportunityCustomers(db);
  return db;
  } catch(error) {db.close();throw error;}
}
export const all = (db, sql, ...args) => db.prepare(sql).all(...args);
export const one = (db, sql, ...args) => db.prepare(sql).get(...args);
export const run = (db, sql, ...args) => db.prepare(sql).run(...args);
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
