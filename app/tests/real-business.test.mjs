import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture,contract,opp } from './helpers/fixture.mjs';
import { one,run } from '../server/database.mjs';
import { today,now } from '../server/domain.mjs';
import { migrateRealBusiness } from '../server/real-schema.mjs';
import { migrateCleanBusiness,RETIRED_OPPORTUNITY_FIELDS,RETIRED_TABLES } from '../server/clean-schema.mjs';
import { migrateRequiredCash } from '../server/cash-schema.mjs';

const classified={sale_type:'新签自建',order_type:'代销'};
function attach(db,id,{entityId=id,mime='application/pdf'}={}) {
  const content=Buffer.from('%PDF-1.4\n'+randomUUID());
  return Number(run(db,'INSERT INTO attachments(entity,entity_id,filename,mime_type,size,sha256,content,created_at) VALUES(?,?,?,?,?,?,?,?)','contract',entityId,'双方盖章合同.pdf',mime,content.length,createHash('sha256').update(content).digest('hex'),content,now()).lastInsertRowid);
}

test('真实流程：草稿不计签约、不赢单、不收款；双方盖章归档后唯一确认赢单',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const before=(await f.request('/state',{actor})).body;
  const draft=await f.request('/contracts',{actor,method:'POST',body:contract(1)});
  assert.equal(draft.status,200,JSON.stringify(draft.body));
  const id=draft.body.id;run(f.db,"UPDATE contracts SET lifecycle='草稿' WHERE id=?",id);run(f.db,"UPDATE opportunities SET stage='商务' WHERE id=1");
  let state=(await f.request('/state',{actor})).body;
  assert.equal(state.contracts.find(c=>c.id===id).lifecycle,'草稿');
  assert.equal(state.opportunities.find(o=>o.id===1).stage,'商务');
  assert.equal(state.team.find(u=>u.id===2).signed,before.team.find(u=>u.id===2).signed);
  assert.equal(state.contracts.find(c=>c.id===id).margin,null);
  assert.equal(state.contracts.find(c=>c.id===id).items[0].rate,null);
  assert.equal((await f.request('/payments',{actor,method:'POST',body:{contract_id:id,amount:1,status:'已到账',pay_date:today()}})).status,409);
  const wrong=attach(f.db,id,{entityId:1});
  assert.equal((await f.request(`/contracts/${id}/archive`,{actor,method:'POST',body:{both_stamped:true,archive_attachment_id:wrong}})).status,400);
  const attachment=attach(f.db,id);
  assert.equal((await f.request(`/contracts/${id}/archive`,{actor,method:'POST',body:{archive_attachment_id:attachment}})).status,400);
  assert.equal((await f.request(`/contracts/${id}/archive`,{actor,method:'POST',body:{both_stamped:true,archive_attachment_id:attachment}})).status,200);
  state=(await f.request('/state',{actor})).body;
  const saved=state.contracts.find(c=>c.id===id);
  assert.equal(saved.lifecycle,'已归档');assert.equal(saved.archive_attachment_id,attachment);
  assert.equal(state.opportunities.find(o=>o.id===1).stage,'赢单');
  assert.equal(saved.collection_status,'未回款');
  assert.equal(state.team.find(u=>u.id===2).signed,before.team.find(u=>u.id===2).signed+10000000);
  assert.ok(state.commission.previews.every(p=>p.lines.every(l=>l.contract_id!==id)),'新合同不能自动套用历史提成规则');
  assert.equal((await f.request(`/contracts/${id}/archive`,{actor,method:'POST',body:{both_stamped:true,archive_attachment_id:attachment}})).status,409);
  assert.equal((await f.request('/payments',{actor,method:'POST',body:{contract_id:id,amount:40000,status:'已到账',pay_date:today()}})).status,200);
  state=(await f.request('/state',{actor})).body;assert.equal(state.contracts.find(c=>c.id===id).collection_status,'部分回款');
  assert.equal((await f.request('/payments',{actor,method:'POST',body:{contract_id:id,amount:60000,status:'已到账',pay_date:today()}})).status,200);
  state=(await f.request('/state',{actor})).body;assert.equal(state.contracts.find(c=>c.id===id).collection_status,'已结清');
});

test('真实商机字段：合同总额、产品金额、销售分类和订单类型分开；外部来源不锁本地修改',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const created=await f.request('/opportunities',{actor,method:'POST',body:opp(3,{...classified,amount:1200.34,product_amount:1000.12,next_action:'',follow_date:null})});
  assert.equal(created.status,200,JSON.stringify(created.body));
  const id=created.body.id,row=one(f.db,'SELECT * FROM opportunities WHERE id=?',id);
  assert.equal(row.amount,120034);assert.equal(row.product_amount,100012);assert.equal(row.sale_type,'新签自建');assert.equal(row.order_type,'代销');
  assert.equal(Object.hasOwn(row,'est_margin'),false);assert.equal(Object.hasOwn(row,'source'),false);assert.equal(Object.hasOwn(row,'nature'),false);
  assert.equal((await f.request(`/opportunities/${id}`,{actor,method:'PATCH',body:{stage:'需求',amount:1500}})).status,200);
  assert.equal((await f.request(`/opportunities/${id}`,{actor,method:'PATCH',body:{stage:'赢单'}})).status,400);
  assert.equal((await f.request(`/opportunities/${id}`,{actor,method:'PATCH',body:{amount:10}})).status,400);
  assert.equal((await f.request('/opportunities',{actor,method:'POST',body:opp(3,{...classified,amount:undefined})})).status,400);
  assert.equal((await f.request('/opportunities',{actor,method:'POST',body:opp(3,{sale_type:'无依据',order_type:'代销'})})).status,400);
  assert.equal((await f.request('/integrations/ppl/pull',{actor,method:'POST',body:{}})).status,410);
  assert.equal((await f.request('/change-requests',{actor,method:'POST',body:{}})).status,410);
});

test('cash金额新建必填、显式零有效，修改不能清空或超过合同总额',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const before=one(f.db,'SELECT COUNT(*) n FROM opportunities').n;
  for(const product_amount of [undefined,null,'',' ',false,-1,100001,1.001]){
    const response=await f.request('/opportunities',{actor,method:'POST',body:opp(3,{product_amount})});
    assert.equal(response.status,400,JSON.stringify({product_amount,response:response.body}));
  }
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM opportunities').n,before);
  const zero=await f.request('/opportunities',{actor,method:'POST',body:opp(3,{amount:0,product_amount:0})});
  assert.equal(zero.status,200,JSON.stringify(zero.body));
  assert.equal(one(f.db,'SELECT product_amount FROM opportunities WHERE id=?',zero.body.id).product_amount,0);
  const made=await f.request('/opportunities',{actor,method:'POST',body:opp(3,{amount:100,product_amount:12.34})});
  assert.equal(made.status,200,JSON.stringify(made.body));
  const id=made.body.id,original=one(f.db,'SELECT name,stage,product_amount FROM opportunities WHERE id=?',id);
  const audit=one(f.db,'SELECT COUNT(*) n FROM audit').n,history=one(f.db,'SELECT COUNT(*) n FROM stage_history').n;
  for(const product_amount of [null,'',' ',false,-1,100.01,1.001]){
    const response=await f.request(`/opportunities/${id}`,{actor,method:'PATCH',body:{product_amount,name:'不应落库',stage:'需求'}});
    assert.equal(response.status,400,JSON.stringify({product_amount,response:response.body}));
  }
  assert.deepEqual(one(f.db,'SELECT name,stage,product_amount FROM opportunities WHERE id=?',id),original);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM audit').n,audit);assert.equal(one(f.db,'SELECT COUNT(*) n FROM stage_history').n,history);
  assert.equal((await f.request(`/opportunities/${id}`,{actor,method:'PATCH',body:{name:'保留原cash'}})).status,200);
  assert.equal(one(f.db,'SELECT product_amount FROM opportunities WHERE id=?',id).product_amount,1234);
  assert.equal((await f.request(`/opportunities/${id}`,{actor,method:'PATCH',body:{product_amount:0}})).status,200);
  assert.equal(one(f.db,'SELECT product_amount FROM opportunities WHERE id=?',id).product_amount,0);
});

test('已有历史cash和分类缺失不阻止维护其他字段，不猜补零或类别',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  // Reconstruct a retained pre-constraint record only in this isolated fixture.
  const names=['opportunities_required_cash_update','opportunities_required_classification_update'];
  const triggers=names.map(name=>one(f.db,"SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",name).sql);
  f.db.exec('BEGIN');for(const name of names)f.db.exec('DROP TRIGGER '+name);
  f.db.exec('UPDATE opportunities SET product_amount=NULL,sale_type=NULL,order_type=NULL WHERE id=1');
  for(const sql of triggers)f.db.exec(sql);f.db.exec('COMMIT');
  const response=await f.request('/opportunities/1',{actor,method:'PATCH',body:{name:'维护已有历史商机',next_action:'补记本次跟进',stage:'需求',amount:100000,reason:'补记历史商机并核对阶段回退'}});
  assert.equal(response.status,200,JSON.stringify(response.body));
  const historical=one(f.db,'SELECT name,next_action,stage,product_amount,sale_type,order_type FROM opportunities WHERE id=1');
  assert.deepEqual({...historical},{name:'维护已有历史商机',next_action:'补记本次跟进',stage:'需求',product_amount:null,sale_type:null,order_type:null});
  for(const body of [{product_amount:null},{product_amount:''},{sale_type:null},{order_type:''}])assert.equal((await f.request('/opportunities/1',{actor,method:'PATCH',body})).status,400);
  assert.equal(one(f.db,'SELECT product_amount FROM opportunities WHERE id=1').product_amount,null);
  assert.equal((await f.request('/opportunities/1',{actor,method:'PATCH',body:{sale_type:'续费'}})).status,200);
  assert.equal(one(f.db,'SELECT order_type FROM opportunities WHERE id=1').order_type,null);
  assert.equal((await f.request('/opportunities/1',{actor,method:'PATCH',body:{product_amount:0,order_type:'代销'}})).status,200);
  assert.throws(()=>run(f.db,'UPDATE opportunities SET product_amount=NULL WHERE id=1'),/cash amount/);
  assert.throws(()=>run(f.db,'UPDATE opportunities SET sale_type=NULL WHERE id=1'),/cannot be cleared/);
});

test('报价明细按原价、数量和折扣精确汇总；不接受与行项冲突的总额',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const body={opportunity_id:1,valid_until:today(),items:[{name:'软件授权',kind:'标品',quantity:3,list_price:99.99,discount_rate:0.85},{name:'实施服务',kind:'实施',quantity:2,list_price:123.45,discount_rate:0.9}]};
  const result=await f.request('/quotes',{actor,method:'POST',body});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const quote=(await f.request('/state',{actor})).body.quotes.find(q=>q.id===result.body.id);
  assert.equal(quote.list_amount,54687);assert.equal(quote.amount,47718);assert.equal(quote.discount_amount,6969);
  assert.equal(quote.items[0].list_price,9999);assert.equal(quote.items[0].amount,25497);
  assert.equal((await f.request('/quotes',{actor,method:'POST',body:{...body,amount:1}})).status,400);
  for(const items of [undefined,[],[null],[false]]){
    const rejected=await f.request('/quotes',{actor,method:'POST',body:{opportunity_id:1,amount:100,valid_until:today(),...(items===undefined?{}:{items})}});
    assert.equal(rejected.status,400,JSON.stringify(rejected.body));
  }
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM quotes WHERE id>=?',result.body.id).n,1,'不完整报价不能遗留记录');
});

test('真实入库必须明确负责人；非归属销售不可修改，联系人必须有联系方式',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),other=await f.login(3);
  const id=3;
  assert.throws(()=>run(f.db,"INSERT INTO customers(name,normalized,owner_id,created_at,updated_at) VALUES('无归属禁止入库','无归属禁止入库',NULL,?,?)",now(),now()),/customer owner is required/);
  assert.equal((await f.request(`/customers/${id}`,{actor:other,method:'PATCH',body:{note:'越权修改'}})).status,403);
  assert.equal((await f.request('/customers',{actor:admin,method:'POST',body:{name:'不许自动归属企业'}})).status,400);
  assert.equal((await f.request('/contacts',{actor:sales,method:'POST',body:{customer_id:id,name:'联络人'}})).status,400);
  assert.equal((await f.request('/contacts',{actor:sales,method:'POST',body:{customer_id:id,name:'联络人',wechat:'已核对微信'}})).status,200);
});

test('管理员注明原因后整笔移交商机与所有关联合同，原销售失去业务明细权限',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),next=await f.login(3);
  const first=await f.request('/contracts',{actor:admin,method:'POST',body:contract(1)});
  const second=await f.request('/contracts',{actor:admin,method:'POST',body:contract(1,{additional:true,owner_id:1})});
  assert.equal(first.status,200);assert.equal(second.status,200);
  const id=first.body.id,otherId=second.body.id;
  assert.equal((await f.request('/opportunities/1',{actor:sales,method:'PATCH',body:{owner_id:3,reason:'销售自行移交'}})).status,403);
  assert.equal((await f.request('/opportunities/1',{actor:admin,method:'PATCH',body:{owner_id:3}})).status,400);
  assert.equal(one(f.db,'SELECT owner_id FROM opportunities WHERE id=1').owner_id,2);
  assert.equal(one(f.db,'SELECT owner_id FROM contracts WHERE id=?',id).owner_id,2);
  assert.equal(one(f.db,'SELECT owner_id FROM contracts WHERE id=?',otherId).owner_id,1);
  const transferred=await f.request('/opportunities/1',{actor:admin,method:'PATCH',body:{owner_id:3,reason:'已确认完整交接'}});
  assert.equal(transferred.status,200,JSON.stringify(transferred.body));
  assert.equal(one(f.db,'SELECT owner_id FROM opportunities WHERE id=1').owner_id,3);
  for(const contractId of [id,otherId])assert.equal(one(f.db,'SELECT owner_id FROM contracts WHERE id=?',contractId).owner_id,3);
  const oldState=(await f.request('/state',{actor:sales})).body,nextState=(await f.request('/state',{actor:next})).body;
  assert.equal(oldState.opportunities.some(o=>o.id===1),false);
  assert.equal(oldState.contracts.some(c=>[id,otherId].includes(c.id)),false);
  assert.ok(nextState.opportunities.some(o=>o.id===1));
  assert.equal(nextState.contracts.filter(c=>[id,otherId].includes(c.id)).length,2);
  const details=f.db.prepare("SELECT detail FROM audit WHERE action='随商机移交合同归属' ORDER BY id").all().map(row=>JSON.parse(row.detail));
  assert.deepEqual(details.map(row=>[row.before,row.after,row.reason]),[[2,3,'已确认完整交接'],[1,3,'已确认完整交接']]);
});

for(const lockedBy of ['提成','绩效'])test(`已有${lockedBy}证据阻止商机移交，前面已处理合同及阶段、审计一并回滚`,async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const first=await f.request('/contracts',{actor,method:'POST',body:contract(1)});
  const second=await f.request('/contracts',{actor,method:'POST',body:contract(1,{additional:true})});
  assert.equal(first.status,200);assert.equal(second.status,200);
  const lockedId=second.body.id;
  // Isolated historical financial evidence: this verifies protection, not a new commission policy.
  if(lockedBy==='提成'){
    const batch=Number(run(f.db,"INSERT INTO commission_batches(sales_id,kind,period,base,rate,amount,status,snapshot,created_at,confirmed_by) VALUES(2,'personal','2026Q1',10000,0.1,1000,'confirmed','{}',?,1)",now()).lastInsertRowid);
    const item=one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',lockedId);
    run(f.db,'INSERT INTO commission_lines(batch_id,contract_id,item_id,base,rebate_rate,rate,amount) VALUES(?,?,?,?,?,?,?)',batch,lockedId,item.id,10000,0.5,0.1,1000);
  }else{
    run(f.db,"INSERT INTO performance_reviews(user_id,month,status,snapshot,reviewed_by,updated_at) VALUES(2,'2026-01','confirmed',?,1,?)",JSON.stringify({evidence:{contracts:[{id:lockedId}]}}),now());
  }
  const before={opportunity:one(f.db,'SELECT owner_id,stage FROM opportunities WHERE id=1'),audit:one(f.db,'SELECT COUNT(*) n FROM audit').n,history:one(f.db,'SELECT COUNT(*) n FROM stage_history').n,revision:one(f.db,'SELECT revision FROM workspace_revision').revision};
  const response=await f.request('/opportunities/1',{actor,method:'PATCH',body:{owner_id:3,reason:'必须整笔交接'}});
  assert.equal(response.status,409,JSON.stringify(response.body));assert.match(response.body.error,new RegExp(lockedBy));
  assert.deepEqual(one(f.db,'SELECT owner_id,stage FROM opportunities WHERE id=1'),before.opportunity);
  for(const contractId of [first.body.id,lockedId])assert.equal(one(f.db,'SELECT owner_id FROM contracts WHERE id=?',contractId).owner_id,2);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM audit').n,before.audit);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM stage_history').n,before.history);
  assert.equal(one(f.db,'SELECT revision FROM workspace_revision').revision,before.revision);
});

function legacyDatabase(){
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE schema_version(version INTEGER PRIMARY KEY);INSERT INTO schema_version VALUES(8);
    CREATE TABLE users(id INTEGER PRIMARY KEY,password TEXT);INSERT INTO users VALUES(1,'isolated-retired-hash');
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),csrf TEXT,expires INTEGER,auth_method TEXT NOT NULL DEFAULT 'password');
    INSERT INTO sessions VALUES('isolated-ding',1,'isolated-csrf',9999999999999,'dingtalk');
    INSERT INTO sessions VALUES('isolated-password',1,'isolated-csrf2',9999999999999,'password');
    CREATE TABLE customers(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL REFERENCES users(id),name TEXT NOT NULL);
    CREATE INDEX customers_owner_status ON customers(owner_id);
    CREATE TABLE opportunities(id INTEGER PRIMARY KEY,customer_id INTEGER REFERENCES customers(id),owner_id INTEGER NOT NULL REFERENCES users(id),stage TEXT,amount INTEGER,product_type TEXT NOT NULL CHECK(product_type IN('标品','实施','混合')),source TEXT NOT NULL DEFAULT '自建' CHECK(source IN('自建','分发')),nature TEXT NOT NULL DEFAULT '新签' CHECK(nature IN('新签','续签')),deal_type TEXT NOT NULL DEFAULT 'new',est_margin INTEGER NOT NULL DEFAULT 0,man_days REAL DEFAULT 0,initial_amount INTEGER,mirror INTEGER DEFAULT 0);
    CREATE TABLE contracts(id INTEGER PRIMARY KEY,opportunity_id INTEGER REFERENCES opportunities(id),customer_id INTEGER REFERENCES customers(id),owner_id INTEGER NOT NULL REFERENCES users(id),amount INTEGER,sign_date TEXT,quote_file TEXT NOT NULL DEFAULT '');
    CREATE TABLE contract_items(id INTEGER PRIMARY KEY,contract_id INTEGER REFERENCES contracts(id),kind TEXT CHECK(kind IN('标品','实施')),amount INTEGER,rate REAL NOT NULL CHECK(rate>=0 AND rate<=1),margin INTEGER NOT NULL CHECK(margin>=0),man_days REAL DEFAULT 0);
    CREATE TABLE quotes(id INTEGER PRIMARY KEY,amount INTEGER);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);INSERT INTO settings VALUES('rules','{"thresholds":{},"sop":{}}');
    CREATE TABLE workspace_revision(id INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO workspace_revision VALUES(1,13);
    INSERT INTO customers VALUES(5,1,'迁移保留客户');
    INSERT INTO opportunities(id,customer_id,owner_id,stage,amount,product_type,initial_amount)VALUES(6,5,1,'商务谈判',123456,'标品',123456);
    INSERT INTO contracts VALUES(7,6,5,1,123456,'2026-01-02','历史报价资料');
    INSERT INTO contract_items VALUES(8,7,'标品',123456,0.45,55555,0);
    CREATE TRIGGER contracts_reference BEFORE INSERT ON contracts WHEN NOT EXISTS(SELECT 1 FROM opportunities WHERE id=NEW.opportunity_id) BEGIN SELECT RAISE(ABORT,'missing opportunity'); END;
    CREATE TRIGGER contract_items_production_insert BEFORE INSERT ON contract_items WHEN typeof(NEW.margin)<>'integer' BEGIN SELECT RAISE(ABORT,'legacy amount'); END;
    CREATE TRIGGER contract_items_production_update BEFORE UPDATE ON contract_items WHEN typeof(NEW.margin)<>'integer' BEGIN SELECT RAISE(ABORT,'legacy amount'); END;
    CREATE TRIGGER opportunities_production_insert BEFORE INSERT ON opportunities WHEN NEW.stage NOT IN('线索','商务谈判','成交') BEGIN SELECT RAISE(ABORT,'legacy stage'); END;
    CREATE TRIGGER opportunities_production_update BEFORE UPDATE ON opportunities WHEN NEW.stage NOT IN('线索','商务谈判','成交') BEGIN SELECT RAISE(ABORT,'legacy stage'); END;
  `);return db;
}

function legacySourceDatabase(){
  const db=legacyDatabase();
  db.exec(`ALTER TABLE customers ADD COLUMN ppl_id TEXT;
    ALTER TABLE opportunities ADD COLUMN ppl_ref TEXT;
    ALTER TABLE opportunities ADD COLUMN ppl_stage TEXT;
    ALTER TABLE opportunities ADD COLUMN synced_at TEXT;
    ALTER TABLE opportunities ADD COLUMN ppl_amount INTEGER;
    ALTER TABLE opportunities ADD COLUMN products TEXT;
    UPDATE customers SET ppl_id='source-customer-5' WHERE id=5;
    UPDATE opportunities SET ppl_ref='SJ202610901',ppl_stage='商务阶段',products='源产品说明' WHERE id=6;
    CREATE TABLE capture_drafts(id INTEGER PRIMARY KEY,payload TEXT);INSERT INTO capture_drafts VALUES(3,'{"summary":"保留旧草稿"}');
    CREATE TABLE change_requests(id INTEGER PRIMARY KEY,payload TEXT);INSERT INTO change_requests VALUES(4,'{"reason":"保留旧申请"}');
    CREATE TABLE sync_runs(id INTEGER PRIMARY KEY,detail TEXT);INSERT INTO sync_runs VALUES(5,'{"count":2}');
  `);
  migrateRealBusiness(db);return db;
}

test('schema9迁移保留ID和已知毛利，未知值可NULL，重复迁移不改记录',()=>{
  const db=legacyDatabase();try{
    migrateRealBusiness(db);
    assert.equal(one(db,'SELECT stage FROM opportunities WHERE id=6').stage,'商务');
    assert.equal(one(db,'SELECT lifecycle FROM contracts WHERE id=7').lifecycle,'历史登记');
    assert.equal(one(db,'SELECT margin FROM contract_items WHERE id=8').margin,55555);
    db.exec("UPDATE opportunities SET owner_id=NULL,product_type=NULL,source=NULL,nature=NULL,deal_type=NULL,est_margin=NULL WHERE id=6; UPDATE contract_items SET margin=NULL,rate=NULL WHERE id=8;");
    const revision=one(db,'SELECT revision FROM workspace_revision').revision;migrateRealBusiness(db);
    assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,revision);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  }finally{db.close();}
});

test('schema9中途失败时结构、原阶段、版本和触发器全部回滚',()=>{
  const db=legacyDatabase();try{
    db.exec("ALTER TABLE quotes ADD COLUMN items TEXT");
    assert.throws(()=>migrateRealBusiness(db));
    assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,8);
    assert.equal(one(db,'SELECT stage FROM opportunities WHERE id=6').stage,'商务谈判');
    assert.equal(db.prepare('PRAGMA table_info(customers)').all().find(c=>c.name==='owner_id').notnull,1);
    assert.ok(one(db,"SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='contracts_reference'"));
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
});

test('schema10物理删除退役表和字段，业务编号及旧来源原行保留且幂等',()=>{
  const db=legacySourceDatabase();try{
    migrateCleanBusiness(db);
    const columns=db.prepare('PRAGMA table_info(opportunities)').all().map(c=>c.name);
    for(const column of [...RETIRED_OPPORTUNITY_FIELDS,'ppl_ref'])assert.ok(!columns.includes(column));
    assert.equal(one(db,'SELECT reference FROM opportunities WHERE id=6').reference,'SJ202610901');
    assert.ok(!db.prepare('PRAGMA table_info(customers)').all().some(c=>c.name==='ppl_id'));
    for(const table of RETIRED_TABLES){
      assert.equal(one(db,"SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?",table).n,0);
      assert.equal(one(db,'SELECT COUNT(*) n FROM source_records WHERE source_table=?',table).n,1);
    }
    const old=JSON.parse(one(db,"SELECT payload FROM source_records WHERE source_table='opportunities'").payload);
    assert.equal(old.products,'源产品说明');assert.equal(old.ppl_stage,'商务阶段');
    assert.equal(one(db,'SELECT margin FROM contract_items WHERE id=8').margin,55555);
    assert.ok(!db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='password'));
    assert.ok(!db.prepare('PRAGMA table_info(contracts)').all().some(c=>c.name==='quote_file'));
    assert.equal(one(db,"SELECT COUNT(*) n FROM sessions WHERE auth_method='dingtalk'").n,1);
    assert.equal(one(db,"SELECT COUNT(*) n FROM sessions WHERE auth_method='password'").n,0);
    const count=one(db,'SELECT COUNT(*) n FROM source_records').n;migrateCleanBusiness(db);
    assert.equal(one(db,'SELECT COUNT(*) n FROM source_records').n,count);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{db.close();}
});

test('schema10遇到未迁移结构依赖时原表字段与来源归档一起回滚',()=>{
  const db=legacySourceDatabase();try{
    db.exec('CREATE VIEW stale_legacy_view AS SELECT mirror FROM opportunities');
    assert.throws(()=>migrateCleanBusiness(db));
    assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,9);
    assert.ok(db.prepare('PRAGMA table_info(opportunities)').all().some(c=>c.name==='mirror'));
    assert.ok(one(db,"SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_drafts'"));
    assert.equal(one(db,'SELECT COUNT(*) n FROM source_records').n,0);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  }finally{db.close();}
});

test('schema10保留旧版本未知分类，新增或维护商机必须先补齐真实分类',()=>{
  const db=legacySourceDatabase();try{
    migrateCleanBusiness(db);
    assert.equal(one(db,'SELECT sale_type FROM opportunities WHERE id=6').sale_type,null);
    assert.equal(one(db,'SELECT order_type FROM opportunities WHERE id=6').order_type,null);
    assert.throws(()=>db.exec('UPDATE opportunities SET amount=123457 WHERE id=6'),/sale_type and order_type are required/);
    assert.equal(one(db,'SELECT amount FROM opportunities WHERE id=6').amount,123456);
    assert.throws(()=>db.exec("INSERT INTO opportunities(id,customer_id,owner_id,stage,amount) VALUES(99,5,1,'线索',100)"),/sale_type and order_type are required/);
    db.exec("UPDATE opportunities SET sale_type='新签自建',order_type='代销' WHERE id=6");
    db.exec('UPDATE opportunities SET amount=123457 WHERE id=6');
    assert.equal(one(db,'SELECT amount FROM opportunities WHERE id=6').amount,123457);
    assert.throws(()=>db.exec('UPDATE opportunities SET sale_type=NULL WHERE id=6'),/sale_type and order_type are required/);
    assert.throws(()=>db.exec("UPDATE opportunities SET order_type='' WHERE id=6"),/CHECK/);
    assert.equal(one(db,'SELECT sale_type FROM opportunities WHERE id=6').sale_type,'新签自建');
  }finally{db.close();}
});

test('schema10拒绝历史未分配负责人，不为迁移猜补或删掉业务记录',()=>{
  const db=legacySourceDatabase();try{
    db.exec('UPDATE customers SET owner_id=NULL WHERE id=5');
    assert.throws(()=>migrateCleanBusiness(db),/未分配负责人/);
    assert.equal(one(db,'SELECT owner_id FROM customers WHERE id=5').owner_id,null);
    assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,9);
    assert.equal(one(db,'SELECT COUNT(*) n FROM source_records').n,0);
  }finally{db.close();}
});

test('schema11历史缺cash或分类仍可维护，新增必填、已知值不能清空且迁移幂等',()=>{
  const db=legacySourceDatabase();try{
    migrateCleanBusiness(db);
    migrateRequiredCash(db);
    assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,11);
    assert.equal(one(db,'SELECT product_amount FROM opportunities WHERE id=6').product_amount,null);
    db.exec("UPDATE opportunities SET amount=123457,stage='需求' WHERE id=6");
    assert.equal(one(db,'SELECT amount FROM opportunities WHERE id=6').amount,123457);
    assert.equal(one(db,'SELECT stage FROM opportunities WHERE id=6').stage,'需求');
    assert.equal(one(db,'SELECT product_amount FROM opportunities WHERE id=6').product_amount,null);
    assert.equal(one(db,'SELECT sale_type FROM opportunities WHERE id=6').sale_type,null);
    assert.equal(one(db,'SELECT order_type FROM opportunities WHERE id=6').order_type,null);
    assert.throws(()=>db.exec("INSERT INTO opportunities(id,customer_id,owner_id,stage,amount,sale_type,order_type) VALUES(99,5,1,'线索',100,'新签自建','代销')"),/cash amount/);
    assert.throws(()=>db.exec("INSERT INTO opportunities(id,customer_id,owner_id,stage,amount,product_amount) VALUES(99,5,1,'线索',100,0)"),/sale_type and order_type are required/);
    db.exec('UPDATE opportunities SET product_amount=0 WHERE id=6');
    db.exec("INSERT INTO opportunities(id,customer_id,owner_id,stage,amount,sale_type,order_type,product_amount) VALUES(99,5,1,'线索',100,'新签自建','代销',0)");
    for(const invalid of ['NULL','-1','0.5','123458'])assert.throws(()=>db.exec('UPDATE opportunities SET product_amount='+invalid+' WHERE id=6'),/cash amount/);
    assert.equal(one(db,'SELECT product_amount FROM opportunities WHERE id=6').product_amount,0);
    for(const column of ['sale_type','order_type'])assert.throws(()=>db.exec('UPDATE opportunities SET '+column+'=NULL WHERE id=99'),/cannot be cleared/);
    const revision=one(db,'SELECT revision FROM workspace_revision').revision;migrateRequiredCash(db);
    assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,revision);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{db.close();}
});

test('schema11中途失败回滚新增触发器、版本与revision，不改历史cash',()=>{
  const db=legacySourceDatabase();try{
    migrateCleanBusiness(db);
    db.exec('CREATE TRIGGER opportunities_required_cash_update BEFORE UPDATE ON opportunities BEGIN SELECT 1; END;');
    const revision=one(db,'SELECT revision FROM workspace_revision').revision;
    assert.throws(()=>migrateRequiredCash(db),/already exists/);
    assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,10);
    assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,revision);
    assert.equal(one(db,"SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name='opportunities_required_cash_insert'").n,0);
    assert.equal(one(db,'SELECT product_amount FROM opportunities WHERE id=6').product_amount,null);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  }finally{db.close();}
});
