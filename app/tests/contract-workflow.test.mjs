import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {fixture,archiveContract} from './helpers/fixture.mjs';
import {one,all,run} from '../server/database.mjs';
import {today,dateAdd} from '../server/domain.mjs';
import {migrateContractWorkflow} from '../server/contract-workflow-schema.mjs';
import {contractFinancials,contractDashboard} from '../server/modules/reporting-prd.mjs';

function migrationFixture(){
 const db=new DatabaseSync(':memory:');
 db.exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_version(version INTEGER PRIMARY KEY); INSERT INTO schema_version VALUES(19); CREATE TABLE workspace_revision(id INTEGER PRIMARY KEY,revision INTEGER); INSERT INTO workspace_revision VALUES(1,7); CREATE TABLE contracts(id INTEGER PRIMARY KEY,name TEXT,amount INTEGER,accept_status TEXT,scope TEXT); INSERT INTO contracts VALUES(1,'历史合同',12345,'待交付','原备注');");
 return db;
}
test('schema22 preserves every old value, leaves new facts NULL and is idempotent',()=>{
 const db=migrationFixture();try{
  const before=one(db,'SELECT * FROM contracts');migrateContractWorkflow(db);
  const after=one(db,'SELECT * FROM contracts');
  for(const [key,value] of Object.entries(before))assert.equal(after[key],value,key);
  for(const key of ['renewal_tag','payment_type','project_status','delivery_staff','project_note'])assert.equal(after[key],null,key);
  assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,8);
  migrateContractWorkflow(db);assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,8);
  assert.throws(()=>run(db,"UPDATE contracts SET project_status='已验收未回款'"));
  assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);
 }finally{db.close();}
});
test('schema22 failure rolls back all added columns and existing data',()=>{
 const db=migrationFixture();try{
  db.exec("CREATE TRIGGER fail_schema22 BEFORE INSERT ON schema_version WHEN NEW.version=22 BEGIN SELECT RAISE(ABORT,'isolated migration failure'); END;");
  const before=JSON.stringify(all(db,'SELECT * FROM contracts'));assert.throws(()=>migrateContractWorkflow(db),/isolated migration failure/);
  assert.equal(JSON.stringify(all(db,'SELECT * FROM contracts')),before);assert.equal(one(db,'SELECT revision FROM workspace_revision').revision,7);
  assert.equal(all(db,'PRAGMA table_info(contracts)').some(c=>c.name==='project_status'),false);
 }finally{db.close();}
});
test('financial aggregates use complete actual items, preserve partial unknown margins, and hide PM margins',()=>{
 const c={id:1,amount:10000},items=[{contract_id:1,name:'产品',kind:'标品',amount:6000,margin:1200},{contract_id:1,name:'交付',kind:'交付',amount:4000,margin:800}];
 assert.deepEqual(contractFinancials(c,items),{product_names:['产品','交付'],product_types:['标品','交付'],financials_complete:true,product_amount:6000,service_amount:4000,product_margin:1200,service_margin:800,product_margin_rate:.2,total_margin:2000});
 const unknown=contractFinancials(c,[items[0],{...items[1],margin:null}]);assert.equal(unknown.product_margin,1200);assert.equal(unknown.service_margin,null);assert.equal(unknown.total_margin,null);
 for(const input of [[],[items[0]],[...items,{contract_id:1,name:'多余',kind:'运维',amount:1,margin:0}],items.map(i=>({...i,kind:'未知分类'}))]){
  const result=contractFinancials(c,input);for(const key of ['product_amount','service_amount','product_margin','service_margin','total_margin','product_margin_rate'])assert.equal(result[key],null,key);
 }
 const pm=contractFinancials(c,items,{hideMargin:true});assert.equal(pm.product_amount,6000);for(const key of ['product_margin','service_margin','total_margin','product_margin_rate'])assert.equal(pm[key],null,key);
 const serviceOnly=contractFinancials(c,[{contract_id:1,name:'服务',kind:'实施',amount:10000,margin:2000}]);assert.equal(serviceOnly.product_amount,0);assert.equal(serviceOnly.product_margin,0);assert.equal(serviceOnly.product_margin_rate,null);
});
test('four dashboard cards distinguish signing, actual receipt, all-time outstanding and expiry months',()=>{
 const payments=[{status:'已到账',pay_date:'2026-11-01',amount:2000},{status:'已到账',pay_date:'2026-10-31',amount:1000},{status:'待到账',promise_date:'2026-11-03',amount:7000}];
 const rows=[{amount:10000,sign_date:'2026-10-01',valid_until:'2026-11-30',lifecycle:'已归档',outstanding:7000,payments},{amount:5000,sign_date:'2026-11-30',valid_until:'2026-12-01',lifecycle:'已归档',outstanding:5000,payments:[]},{amount:9000,sign_date:'2026-11-01',valid_until:'2026-11-30',lifecycle:'草稿',outstanding:9000,payments:[]}];
 const result=contractDashboard(rows,'2026-11');assert.equal(result.signed_amount,5000);assert.equal(result.received_amount,2000);assert.equal(result.outstanding_amount,12000);assert.equal(result.expiring_amount,10000);
 assert.match(result.outstanding_basis,/不限制签约月份/);
});
async function setup(t){const f=await fixture(t);migrateContractWorkflow(f.db);return {...f,actor:await f.login(1)};}
const body=(extra={})=>({customer_id:1,name:'听记合同隔离验证',owner_id:2,sign_date:today(),items:[{name:'产品授权',kind:'标品',amount:60,margin_rate:.2},{name:'交付服务',kind:'交付',amount:40,margin:8}],...extra});
async function create(f,extra={}){const result=await f.request('/contracts',{actor:f.actor,method:'POST',body:body(extra)});assert.equal(result.status,200,JSON.stringify(result.body));return result.body.id;}
test('contract metadata and input margin rates are maintained without duplicate financial storage or accounts',async t=>{
 const f=await setup(t);run(f.db,"INSERT INTO users(id,name,username,role,created_at) VALUES(99,'隔离项目经理','isolated_pm','pm',?)",new Date().toISOString());
 const pm={id:99},usersBefore=one(f.db,'SELECT count(*) n FROM users').n;
 const id=await create(f,{renewal_tag:'新签（自建）',payment_type:'客户直付天元',project_status:'交付中',collaborator_pm:pm.id,delivery_staff:'研发甲、交付乙',project_note:'已确认排期'});
 const rounded=await create(f,{items:[{name:'按分舍入产品',kind:'标品',amount:.03,margin_rate:.5}]});
 assert.equal(one(f.db,'SELECT margin FROM contract_items WHERE contract_id=?',rounded).margin,2);
 const contractsBefore=one(f.db,'SELECT count(*) n FROM contracts').n;
 assert.equal((await f.request('/contracts',{actor:f.actor,method:'POST',body:body({items:[{name:'矛盾毛利',kind:'标品',amount:60,margin:10,margin_rate:.2}]})})).status,400);
 assert.equal(one(f.db,'SELECT count(*) n FROM contracts').n,contractsBefore);
 let c=(await f.request('/state',{actor:f.actor})).body.contracts.find(c=>c.id===id);
 assert.equal(c.amount,10000);assert.equal(c.product_amount,6000);assert.equal(c.service_amount,4000);assert.equal(c.total_margin,2000);assert.equal(c.product_margin_rate,.2);assert.equal(c.items[0].rate,null);assert.equal(c.renewal_tag,'新签（自建）');assert.equal(c.delivery_staff,'研发甲、交付乙');
 for(const project_status of ['验收中','已验收未结算','已结项','运维中','暂停','续费中'])assert.equal((await f.request(`/contracts/${id}`,{actor:f.actor,method:'PATCH',body:{project_status}})).status,200);
 const item=c.items[0];
 assert.equal((await f.request(`/items/${item.id}`,{actor:f.actor,method:'PATCH',body:{margin_rate:.125,reason:'核实实际成本'}})).status,200);
 assert.equal(one(f.db,'SELECT margin FROM contract_items WHERE id=?',item.id).margin,750);
 assert.equal((await f.request(`/items/${item.id}`,{actor:f.actor,method:'PATCH',body:{margin:10,margin_rate:.2,reason:'矛盾测试'}})).status,400);
 assert.equal((await f.request(`/items/${item.id}`,{actor:f.actor,method:'PATCH',body:{margin_rate:1.01,reason:'越界测试'}})).status,400);
 assert.equal((await f.request(`/items/${item.id}`,{actor:f.actor,method:'PATCH',body:{margin_rate:null,reason:'成本待复核'}})).status,200);
 assert.equal(one(f.db,'SELECT margin FROM contract_items WHERE id=?',item.id).margin,null);
 assert.equal((await f.request(`/contracts/${id}`,{actor:f.actor,method:'PATCH',body:{project_status:'已验收未回款'}})).status,400);
 assert.equal((await f.request(`/contracts/${id}`,{actor:f.actor,method:'PATCH',body:{collaborator_pm:2}})).status,400);
 assert.equal(one(f.db,'SELECT count(*) n FROM users').n,usersBefore);
 const sales=await f.login(2);assert.equal((await f.request(`/contracts/${id}`,{actor:sales,method:'PATCH',body:{payment_type:'千帆收款'}})).status,403);
 const pmActor=await f.login(pm.id);assert.equal((await f.request(`/contracts/${id}`,{actor:pmActor,method:'PATCH',body:{project_note:'PM更新进度',project_status:'运维中'}})).status,200);
 assert.equal((await f.request(`/contracts/${id}`,{actor:pmActor,method:'PATCH',body:{renewal_tag:'续费'}})).status,403);
 c=(await f.request('/state',{actor:pmActor})).body.contracts.find(c=>c.id===id);assert.equal(c.product_margin,null);assert.equal(c.service_margin,null);assert.equal(c.total_margin,null);assert.ok(c.items.every(i=>!Object.hasOwn(i,'margin')&&!Object.hasOwn(i,'rate')));
});
test('contract dates and numbers validate archive boundaries, duplicate numbers, transactions and settlement locks',async t=>{
 const f=await setup(t),id=await create(f),second=await create(f,{contract_no:'唯一合同编号'});
 const patch=body=>f.request(`/contracts/${id}`,{actor:f.actor,method:'PATCH',body});
 assert.equal((await patch({name:'新合同名',contract_no:'唯一合同编号'})).status,409);assert.equal(one(f.db,'SELECT name FROM contracts WHERE id=?',id).name,'听记合同隔离验证');
 assert.equal((await patch({name:'新合同名',contract_no:'独立编号',sign_date:dateAdd(-1),reason:'核对签约原件'})).status,200);
 await archiveContract(f,f.actor,id);
 assert.equal((await patch({sign_date:dateAdd(1),reason:'未来日期'})).status,400);
 assert.equal((await patch({sign_date:dateAdd(-1),valid_until:dateAdd(-2),reason:'逆序日期'})).status,400);
 const item=one(f.db,'SELECT id FROM contract_items WHERE contract_id=?',id);
 const batch=Number(run(f.db,"INSERT INTO commission_batches(sales_id,kind,period,base,rate,amount,status,snapshot,created_at,confirmed_by) VALUES(2,'personal','2026Q4',10000,0.03,300,'confirmed','{}',?,1)",new Date().toISOString()).lastInsertRowid);
 run(f.db,"INSERT INTO commission_lines(batch_id,contract_id,item_id,base,rebate_rate,rate,amount,component) VALUES(?,?,?,?,?,?,?,?)",batch,id,item.id,10000,null,.03,300,'legacy');
 assert.equal((await patch({sign_date:dateAdd(-2),reason:'结算后改日'})).status,409);
 assert.equal((await f.request(`/items/${item.id}`,{actor:f.actor,method:'PATCH',body:{margin_rate:.3,reason:'结算后改毛利'}})).status,409);
 assert.equal((await f.request(`/items/${item.id}`,{actor:f.actor,method:'PATCH',body:{kind:'交付',reason:'结算后改分类'}})).status,409);
 await archiveContract(f,f.actor,second);
 run(f.db,"INSERT INTO performance_reviews(user_id,month,status,snapshot,reviewed_by,updated_at) VALUES(2,?,'confirmed','{}',1,?)",dateAdd(-1).slice(0,7),new Date().toISOString());
 assert.equal((await f.request(`/contracts/${second}`,{actor:f.actor,method:'PATCH',body:{sign_date:dateAdd(-1),reason:'不能跨入已确认绩效月份'}})).status,409);
 const before=one(f.db,'SELECT * FROM contracts WHERE id=?',second);
 f.db.exec("CREATE TRIGGER isolated_contract_audit BEFORE INSERT ON audit WHEN NEW.action='更新合同' BEGIN SELECT RAISE(ABORT,'isolated audit failure'); END;");
 assert.equal((await f.request(`/contracts/${second}`,{actor:f.actor,method:'PATCH',body:{project_status:'暂停',delivery_staff:'新人员'}})).status,500);
 assert.deepEqual(one(f.db,'SELECT * FROM contracts WHERE id=?',second),before);
});
test('payment management reuses actual receipts, keeps plans separate, preserves idempotency and cannot rewrite received records',async t=>{
 const f=await setup(t),id=await create(f);await archiveContract(f,f.actor,id);
 const plan=await f.request('/payments',{actor:f.actor,method:'POST',body:{contract_id:id,amount:100,status:'待到账',promise_date:dateAdd(2)}});assert.equal(plan.status,200);
 const state=async()=>((await f.request('/state',{actor:f.actor})).body.contracts.find(c=>c.id===id));
 let c=await state();assert.equal(c.collected,0);assert.equal(c.outstanding,10000);assert.equal(c.received_status,'否');assert.equal(c.next_expected_at,dateAdd(2));assert.equal(c.last_received_at,null);
 assert.equal((await f.request(`/payments/${plan.body.id}`,{actor:f.actor,method:'PATCH',body:{promise_date:dateAdd(3),note:'付款节点变更',reason:'双方确认'}})).status,200);
 assert.equal((await f.request(`/payments/${plan.body.id}`,{actor:f.actor,method:'PATCH',body:{amount:90,reason:'不能改金额'}})).status,400);
 const key=randomUUID(),receipt={contract_id:id,amount:30,product_amount:20,status:'已到账',pay_date:today()};
 const first=await f.request('/payments',{actor:f.actor,method:'POST',body:receipt,key}),again=await f.request('/payments',{actor:f.actor,method:'POST',body:receipt,key});assert.equal(first.status,200);assert.equal(first.body.id,again.body.id);
 c=await state();assert.equal(c.collected,3000);assert.equal(c.outstanding,7000);assert.equal(c.received_status,'部分回款');assert.equal(c.last_received_at,today());assert.equal(c.next_expected_at,dateAdd(3));
 const product=c.items.find(i=>i.kind==='标品');assert.equal((await f.request(`/items/${product.id}`,{actor:f.actor,method:'PATCH',body:{kind:'交付',reason:'会冲突已收产品款'}})).status,409);
 assert.equal((await f.request(`/payments/${first.body.id}`,{actor:f.actor,method:'PATCH',body:{promise_date:dateAdd(3),reason:'到账后改写'}})).status,409);
 assert.equal((await f.request(`/payments/${plan.body.id}/receive`,{actor:f.actor,method:'POST',body:{pay_date:today()}})).status,400);
 assert.equal((await f.request('/payments',{actor:f.actor,method:'POST',body:{contract_id:id,amount:70,product_amount:40,status:'已到账',pay_date:today()}})).status,200);
 c=await state();assert.equal(c.received_status,'是');assert.equal(c.collection_status,'已结清');assert.equal(c.outstanding,0);
 const sales=await f.login(2);assert.equal((await f.request(`/payments/${plan.body.id}`,{actor:sales,method:'PATCH',body:{note:'无权改',reason:'测试'}})).status,403);
});

test('legacy 未分类 and 实施 items allow unrelated maintenance without guessing classification or accepting newly assigned retired kinds',async t=>{
 const f=await setup(t),id=await create(f),items=all(f.db,'SELECT * FROM contract_items WHERE contract_id=? ORDER BY id',id);
 run(f.db,"UPDATE contract_items SET kind='未分类' WHERE id=?",items[0].id);
 const update=await f.request(`/items/${items[0].id}`,{actor:f.actor,method:'PATCH',body:{name:'仅更正历史名称',kind:'未分类',payment_date:dateAdd(2),margin_rate:.2,reason:'原分类尚未核实，维护已知字段'}});
 assert.equal(update.status,200,JSON.stringify(update.body));
 const saved=one(f.db,'SELECT * FROM contract_items WHERE id=?',items[0].id);
 assert.equal(saved.kind,'未分类');assert.equal(saved.amount,items[0].amount);assert.equal(saved.margin,1200);assert.equal(saved.name,'仅更正历史名称');assert.equal(saved.payment_date,dateAdd(2));
 const c=(await f.request('/state',{actor:f.actor})).body.contracts.find(c=>c.id===id);
 assert.equal(c.product_amount,null);assert.equal(c.service_amount,null);assert.equal(c.total_margin,null);
 for(const kind of ['未分类','实施']){
  assert.equal((await f.request(`/items/${items[1].id}`,{actor:f.actor,method:'PATCH',body:{kind,reason:'不得新设退役分类'}})).status,400);
  assert.equal(one(f.db,'SELECT kind FROM contract_items WHERE id=?',items[1].id).kind,'交付');
 }
 run(f.db,"UPDATE contract_items SET kind='实施' WHERE id=?",items[1].id);
 assert.equal((await f.request(`/items/${items[1].id}`,{actor:f.actor,method:'PATCH',body:{kind:'实施',name:'保留原实施分类'}})).status,200);
 assert.equal(one(f.db,'SELECT kind FROM contract_items WHERE id=?',items[1].id).kind,'实施');
});
