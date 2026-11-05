import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {migrateContractRetirement} from '../server/contract-retirement-schema.mjs';
import {fixture} from './helpers/fixture.mjs';
import {contractDashboard} from '../server/modules/reporting-prd.mjs';
import {one,all,run} from '../server/database.mjs';

function legacy(){
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(28);CREATE TABLE workspace_revision(id INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO workspace_revision VALUES(1,9);CREATE TABLE contracts(id INTEGER PRIMARY KEY,owner_id INTEGER,name TEXT,archived_at TEXT,contract_no TEXT);INSERT INTO contracts VALUES(7,1,'原已盖章合同','2026-10-01','HT-ORIGINAL');CREATE UNIQUE INDEX contracts_number ON contracts(contract_no) WHERE contract_no IS NOT NULL;");
 return db;
}
test('schema29区分签章归档与退出当前业务，完整保留旧字段并幂等',()=>{
 const db=legacy();try{
  migrateContractRetirement(db);
  assert.deepEqual({...one(db,'SELECT * FROM contracts')},{id:7,owner_id:1,name:'原已盖章合同',archived_at:'2026-10-01',contract_no:'HT-ORIGINAL',retired_at:null});
  run(db,"UPDATE contracts SET retired_at='2026-11-04' WHERE id=7");
  run(db,"INSERT INTO contracts(id,owner_id,name,contract_no) VALUES(8,1,'重导后的同号合同','HT-ORIGINAL')");
  assert.throws(()=>run(db,"INSERT INTO contracts(id,owner_id,name,contract_no) VALUES(9,1,'当前同号合同仍禁止','HT-ORIGINAL')"),/UNIQUE/);
  assert.equal(one(db,'SELECT max(version) n FROM schema_version').n,29);
  const revision=one(db,'SELECT revision FROM workspace_revision').revision;
  migrateContractRetirement(db);assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,revision);
 }finally{db.close();}
});
test('schema29失败回滚新增字段及版本，不改变原合同',()=>{
 const db=legacy();try{
  db.exec("CREATE TRIGGER fail29 BEFORE INSERT ON schema_version WHEN NEW.version=29 BEGIN SELECT RAISE(ABORT,'forced29');END;");
  assert.throws(()=>migrateContractRetirement(db),/forced29/);
  assert.equal(all(db,'PRAGMA table_info(contracts)').some(c=>c.name==='retired_at'),false);
  assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,9);
  assert.equal(one(db,'SELECT archived_at FROM contracts').archived_at,'2026-10-01');
 }finally{db.close();}
});
test('退出当前业务的合同保留原件、行项和回款，排除当前列表与简报并禁止继续记款',async t=>{
 const f=await fixture(t),actor=await f.login(1);
 const initial=(await f.request('/state',{actor})).body;
 const contract=initial.contracts[0];assert.ok(contract);
 const items=all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',contract.id),payments=all(f.db,'SELECT * FROM payments WHERE contract_id=?',contract.id);
 const original=one(f.db,'SELECT * FROM contracts WHERE id=?',contract.id);
 run(f.db,'UPDATE contracts SET retired_at=? WHERE id=?',new Date().toISOString(),contract.id);
 const state=(await f.request('/state',{actor})).body;
 assert.equal(state.contracts.some(c=>c.id===contract.id),false);
 assert.deepEqual(all(f.db,'SELECT * FROM contract_items WHERE contract_id=?',contract.id),items);
 assert.deepEqual(all(f.db,'SELECT * FROM payments WHERE contract_id=?',contract.id),payments);
 const retained=one(f.db,'SELECT * FROM contracts WHERE id=?',contract.id);
 for(const [key,value] of Object.entries(original))if(key!=='retired_at')assert.equal(retained[key],value,key);
 assert.equal((await f.request('/payments',{actor,method:'POST',body:{contract_id:contract.id,amount:1,status:'待到账',promise_date:'2026-12-31'}})).status,410);
 assert.equal((await f.request('/contracts/'+contract.id,{actor,method:'PATCH',body:{name:'不得改历史原件',reason:'测试'}})).status,410);
 const active={amount:100,sign_date:'2026-11-01',lifecycle:'历史登记',outstanding:100,payments:[]};
 const d=contractDashboard([active,{...active,amount:9999,retired_at:'2026-11-04'}],'2026-11');
 assert.equal(d.signed_amount,100);assert.equal(d.outstanding_amount,100);
});
