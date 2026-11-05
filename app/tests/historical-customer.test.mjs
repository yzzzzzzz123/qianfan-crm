import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {one,all} from '../server/database.mjs';
import {migrateHistoricalCustomerOwners} from '../server/historical-customer-schema.mjs';
import {fixture,customer,opp} from './helpers/fixture.mjs';
import {formCustomers} from '../public/modules/customers.js';
import {dashboardScope} from '../public/modules/dashboards.js';

test('历史客户迁移保留原客户、关联记录、索引、触发器及序列，失败可回滚',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(12);
    CREATE TABLE workspace_revision(id INTEGER PRIMARY KEY,revision INTEGER); INSERT INTO workspace_revision VALUES(1,0);
    CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1);
    CREATE TABLE customers(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,owner_id INTEGER NOT NULL REFERENCES users(id));
    CREATE TABLE contacts(id INTEGER PRIMARY KEY,customer_id INTEGER REFERENCES customers(id));
    INSERT INTO customers VALUES(1,'原客户',1); INSERT INTO customers VALUES(99,'已删除',1); DELETE FROM customers WHERE id=99;
    INSERT INTO contacts VALUES(1,1); CREATE INDEX customers_owner ON customers(owner_id);
    CREATE VIEW customer_names AS SELECT name FROM customers;
    CREATE TRIGGER customer_revision AFTER UPDATE ON customers BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;`);
  const data=all(db,'SELECT * FROM customers'),contacts=all(db,'SELECT * FROM contacts');
  const schema=all(db,"SELECT type,name,sql FROM sqlite_master ORDER BY type,name");
  db.exec("CREATE TRIGGER reject_version BEFORE INSERT ON schema_version WHEN NEW.version=13 BEGIN SELECT RAISE(ABORT,'forced migration failure'); END");
  assert.throws(()=>migrateHistoricalCustomerOwners(db),/forced migration failure/);
  db.exec('DROP TRIGGER reject_version');
  assert.deepEqual(all(db,"SELECT type,name,sql FROM sqlite_master ORDER BY type,name"),schema);
  assert.deepEqual(all(db,'SELECT * FROM customers'),data);
  assert.equal(one(db,'PRAGMA foreign_keys').foreign_keys,1);
  migrateHistoricalCustomerOwners(db);
  assert.deepEqual(all(db,'SELECT * FROM customers'),data);
  assert.deepEqual(all(db,'SELECT * FROM contacts'),contacts);
  assert.equal(one(db,"SELECT seq FROM sqlite_sequence WHERE name='customers'").seq,99);
  assert.equal(one(db,'PRAGMA table_info(customers)').name,'id');
  assert.equal(all(db,'PRAGMA table_info(customers)').find(c=>c.name==='owner_id').notnull,0);
  assert.throws(()=>db.prepare('INSERT INTO customers(name,owner_id) VALUES(?,NULL)').run('缺负责人'),/owner is required/);
  assert.throws(()=>db.exec('UPDATE customers SET owner_id=NULL WHERE id=1'),/known owner cannot be cleared/);
  const revised=one(db,'SELECT revision FROM workspace_revision').revision;
  migrateHistoricalCustomerOwners(db);
  assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,revised);
  assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);db.close();
});

test('客户资产按原关联销售显示未定主负责人历史客户',()=>{
  const state={actor:{id:1},customers:[{id:1,owner_id:2},{id:2,owner_id:null,collaborators:[2,3]},{id:3,owner_id:3,collaborators:[2]}],opportunities:[],contracts:[],activities:[],team:[{id:2},{id:3}]};
  assert.deepEqual(dashboardScope(state,{view:'assets',owner:'2'}).customers.map(c=>c.id),[1,2]);
  assert.deepEqual(dashboardScope(state,{view:'assets',owner:'3'}).customers.map(c=>c.id),[2,3]);
  assert.deepEqual(dashboardScope(state,{view:'assets',owner:'4'}).customers,[]);
});

test('历史未定负责人客户可维护其他字段，不能猜改销售归属或绕过新建必填',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const guard=one(f.db,"SELECT sql FROM sqlite_master WHERE name='customers_required_owner_insert'").sql;
  f.db.exec('BEGIN; DROP TRIGGER customers_required_owner_insert');
  const id=Number(f.db.prepare('INSERT INTO customers(name,normalized,owner_id,note,created_at,updated_at) VALUES(?,?,NULL,?,?,?)').run('历史多销售客户','历史多销售客户','原表未提供主负责人','2026-10-01','2026-10-01').lastInsertRowid);
  f.db.exec(guard);f.db.exec('COMMIT');
  const created=await f.request('/opportunities',{actor,method:'POST',body:opp(id,{owner_id:2})});
  assert.equal(created.status,200,JSON.stringify(created.body));
  for(const owner_id of ['',null]){
    const update=await f.request('/customers/'+id,{actor,method:'PATCH',body:{owner_id,note:'保留原始归属'}});
    assert.equal(update.status,200,JSON.stringify(update.body));
    assert.equal(one(f.db,'SELECT owner_id FROM customers WHERE id=?',id).owner_id,null);
    assert.equal(one(f.db,'SELECT owner_id FROM opportunities WHERE id=?',created.body.id).owner_id,2);
  }
  const state=(await f.request('/state',{actor})).body;
  assert.match(formCustomers(state,'edit-customer',id,{}),/value="" selected[^>]*>原始资料未提供/);
  const added=await f.request('/customers',{actor,method:'POST',body:customer({name:'缺负责人新客户',owner_id:null})});
  assert.equal(added.status,400);
  const transfer=await f.request('/customers/'+id,{actor,method:'PATCH',body:{owner_id:3,reason:'管理员确认客户主负责人'}});
  assert.equal(transfer.status,200);
  assert.equal(one(f.db,'SELECT owner_id FROM opportunities WHERE id=?',created.body.id).owner_id,2);
});
