import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/fixture.mjs';
import {all,one,run} from '../server/database.mjs';
import {today,dateAdd,quarter} from '../server/domain.mjs';
import {createIntakeAI,AI_MODEL,AI_SYSTEM,validateUpload} from '../server/ai-intake.mjs';
import {intakeSchema,fieldNames,schemaForAI} from '../public/modules/intake-schema.js';

const operation=(type,data,extra={})=>({type,action:'create',ref:type+'1',data,evidence:'隔离测试资料',source_file:'粘贴内容',...extra});
const stub=operations=>({configured:true,model:AI_MODEL,prepare:async()=>({summary:'资料识别完成',questions:[],operations,model:AI_MODEL,usage:{},sources:[]})});
async function receive(f,actor,text='隔离上传',extra={}) {return f.request('/ai/intake',{actor,method:'POST',body:{text,...extra}});}
async function batch(f,actor,id) {const result=await f.request('/ai/batches/'+id,{actor});assert.equal(result.status,200);return result.body;}
async function confirm(f,actor,b,extra={}) {return f.request(`/ai/batches/${b.id}/confirm`,{actor,method:'POST',body:{version:b.version,acknowledged:true},...extra});}
const quoteItems=amount=>[{name:'测试授权',kind:'标品',quantity:1,list_price:amount,discount_rate:1}];
const signedFile=()=>({name:'双方签章.pdf',base64:Buffer.from('%PDF-1.7\nSynthetic test container; no claim of verified signatures').toString('base64')});
const archive=()=>operation('contract_archive',{contract_id:'$contract1',source_file:'双方签章.pdf',both_stamped:true},{source_file:'双方签章.pdf'});
const customer=operation('customer',{name:'AI隔离新客户',owner_id:2});
const opportunity=operation('opportunity',{customer_id:'$customer1',name:'AI隔离新商机',owner_id:2,stage:'需求',amount:10000,product_amount:0,sale_type:'新签自建',order_type:'代销',next_action:'安排演示',follow_date:dateAdd(2)});

test('固定字段规范由模型提示与服务端共享，禁止未知字段、无关别名和动作不支持的字段',async t=>{
  assert.ok(Object.isFrozen(intakeSchema));assert.ok(AI_SYSTEM.includes(JSON.stringify(schemaForAI())));
  for(const def of Object.values(intakeSchema))for(const field of def.fields.split(' '))assert.ok(fieldNames[field],field);
  for(const op of [operation('customer',{name:'越界',owner_id:2,external_custom_field:'不允许'}),operation('customer',{level:'A'},{action:'update',target_id:1}),operation('contract',{accept_status:'已验收'},{action:'update',target_id:1}),operation('rules',{customer_name:'华东数智科技有限公司'}),operation('contact',{customer_id:1,name:'联系人',phone:'13800001234',active:false}),operation('contract',{customer_id:2},{action:'update',target_id:1})]) {
    const f=await fixture(t,{aiProvider:stub([op])}),actor=await f.login(1);
    const r=await receive(f,actor);assert.equal(r.status,400);assert.equal(one(f.db,'SELECT count(*) n FROM ai_import_batches').n,0);
  }
});

test('cash金额是商机必填事实，缺失空白整批拦截，明确零值可以确认且不复制合同总额',async t=>{
  assert.ok(intakeSchema.opportunity.required.includes('product_amount'));
  assert.ok(schemaForAI().opportunity.required_for_create.includes('product_amount'));
  assert.match(AI_SYSTEM,/合同总金额和cash金额均为必填/);
  assert.match(AI_SYSTEM,/cash可接受原文明确填写的0/);
  const provider=stub([]),f=await fixture(t,{aiProvider:provider}),actor=await f.login(1);
  const before=one(f.db,'SELECT COUNT(*) n FROM customers').n;
  for(const value of [undefined,null,'','   ']){
    provider.prepare=stub([customer,operation('opportunity',{...opportunity.data,product_amount:value})]).prepare;
    const received=await receive(f,actor,'缺cash金额-'+randomUUID());assert.equal(received.status,200);
    const draft=await batch(f,actor,received.body.id);
    assert.equal(received.body.valid,false);assert.match(draft.errors.map(e=>e.message).join(' '),/cash金额/);
    assert.equal((await confirm(f,actor,draft)).status,422);
    assert.equal(one(f.db,'SELECT COUNT(*) n FROM customers').n,before);
    assert.equal(one(f.db,"SELECT COUNT(*) n FROM opportunities WHERE name='AI隔离新商机'").n,0);
  }
  provider.prepare=stub([customer,opportunity]).prepare;
  const received=await receive(f,actor,'cash金额明确填写0-'+randomUUID()),draft=await batch(f,actor,received.body.id);
  assert.deepEqual(draft.errors,[]);assert.equal((await confirm(f,actor,draft)).status,200);
  const saved=one(f.db,"SELECT id,amount,product_amount FROM opportunities WHERE name='AI隔离新商机'");
  assert.equal(saved.product_amount,0);assert.equal(saved.amount,1000000);
  provider.prepare=stub([operation('opportunity',{product_amount:null},{action:'update',target_id:saved.id})]).prepare;
  const update=await receive(f,actor,'不能把cash金额清空-'+randomUUID()),invalid=await batch(f,actor,update.body.id);
  assert.equal((await confirm(f,actor,invalid)).status,422);
  assert.equal(one(f.db,'SELECT product_amount FROM opportunities WHERE id=?',saved.id).product_amount,0);
});

test('历史商机未提供cash时可只更新其他字段，保留原记录与NULL且不强迫补造金额',async t=>{
  assert.match(AI_SYSTEM,/明确更新其他字段时，只输出这些修改字段，不要求补cash/);
  const provider=stub([]),f=await fixture(t,{aiProvider:provider}),actor=await f.login(1);
  const old=one(f.db,"SELECT * FROM opportunities WHERE stage NOT IN ('赢单','输单') LIMIT 1");
  // Model a pre-existing historical NULL, then restore the live write guard
  // before exercising the actual AI preview/confirm path.
  const trigger=one(f.db,"SELECT sql FROM sqlite_master WHERE type='trigger' AND name='opportunities_required_cash_update'");
  f.db.exec('DROP TRIGGER opportunities_required_cash_update');
  run(f.db,'UPDATE opportunities SET product_amount=NULL WHERE id=?',old.id);
  f.db.exec(trigger.sql);
  const activities=all(f.db,'SELECT * FROM activities WHERE opportunity_id=?',old.id);
  provider.prepare=stub([operation('opportunity',{next_action:'按历史范围继续跟进'},{action:'update',target_id:old.id})]).prepare;
  const received=await receive(f,actor,'只更新历史商机的下一步动作-'+randomUUID()),draft=await batch(f,actor,received.body.id);
  assert.equal(received.body.valid,true);assert.deepEqual(draft.errors,[]);
  assert.equal(Object.hasOwn(draft.operations[0].data,'product_amount'),false);
  assert.equal((await confirm(f,actor,draft)).status,200);
  const saved=one(f.db,'SELECT * FROM opportunities WHERE id=?',old.id);
  assert.equal(saved.id,old.id);assert.equal(saved.customer_id,old.customer_id);assert.equal(saved.amount,old.amount);
  assert.equal(saved.product_amount,null);assert.equal(saved.next_action,'按历史范围继续跟进');
  assert.deepEqual(all(f.db,'SELECT * FROM activities WHERE opportunity_id=?',old.id),activities);
});

test('销售文档指定其他负责人时禁止入库，不静默替换负责人',async t=>{
  const f=await fixture(t,{aiProvider:stub([operation('customer',{name:'错误归属客户',owner_id:3})])}),actor=await f.login(2);
  const r=await receive(f,actor),b=await batch(f,actor,r.body.id);assert.equal(r.body.valid,false);assert.match(b.errors[0].message,/文档负责人/);assert.equal((await confirm(f,actor,b)).status,422);
});

test('绩效评定不再允许AI导入，历史未确认草稿同样不能绕过直接设置',async t=>{
  assert.equal(intakeSchema.performance_review,undefined);
  assert.equal(schemaForAI().performance_review,undefined);
  const legacy=operation('performance_review',{user_id:2,month:today().slice(0,7),adjustment:40,reason:'AI不应评分',status:'draft'});
  const provider=stub([legacy]),f=await fixture(t,{aiProvider:provider}),actor=await f.login(1);
  const before=one(f.db,'SELECT count(*) n FROM performance_reviews').n;
  assert.equal((await receive(f,actor,'旧类型评分资料')).status,400);
  provider.prepare=stub([customer]).prepare;
  const r=await receive(f,actor,'待确认的历史批次'),b=await batch(f,actor,r.body.id);
  run(f.db,'UPDATE ai_import_batches SET operations=? WHERE id=?',JSON.stringify([legacy]),b.id);
  const rejected=await confirm(f,actor,b);assert.equal(rejected.status,400);assert.match(rejected.body.error,/不支持.*数据类型/);
  assert.equal(one(f.db,'SELECT count(*) n FROM performance_reviews').n,before);
  assert.equal(one(f.db,'SELECT state FROM ai_import_batches WHERE id=?',b.id).state,'draft');
});

test('季度目标只允许人工设置，AI新提案和旧待确认草稿都不能写入目标表',async t=>{
  assert.equal(intakeSchema.target,undefined);assert.equal(schemaForAI().target,undefined);
  const legacy=operation('target',{user_id:2,quarter:quarter(),amount:345678});
  const provider=stub([legacy]),f=await fixture(t,{aiProvider:provider}),actor=await f.login(1);
  const before=all(f.db,'SELECT * FROM targets ORDER BY user_id,quarter');
  assert.equal((await receive(f,actor,'旧目标资料')).status,400);
  provider.prepare=stub([customer]).prepare;
  const r=await receive(f,actor,'旧未确认批次'),draft=await batch(f,actor,r.body.id);
  run(f.db,'UPDATE ai_import_batches SET operations=? WHERE id=?',JSON.stringify([legacy]),draft.id);
  assert.equal((await confirm(f,actor,draft)).status,400);
  assert.deepEqual(all(f.db,'SELECT * FROM targets ORDER BY user_id,quarter'),before);
});

test('兼容真实Qwen返回的单键对象引用，跨文件关系规范化且仍拒绝额外引用字段',async t=>{
  const f=await fixture(t,{aiProvider:stub([customer,operation('opportunity',{...opportunity.data,customer_id:{$ref:'customer1'}}),operation('contact',{customer_id:{$ref:'customer1'},name:'对象引用联系人',phone:'13800001234'})])}),actor=await f.login(1);
  const r=await receive(f,actor),b=await batch(f,actor,r.body.id);assert.deepEqual(b.errors,[]);assert.equal(b.operations.find(o=>o.type==='opportunity').data.customer_id,'$customer1');
  assert.equal((await confirm(f,actor,b)).status,200);const c=one(f.db,"SELECT id FROM customers WHERE name='AI隔离新客户'");assert.equal(one(f.db,"SELECT customer_id FROM contacts WHERE name='对象引用联系人'").customer_id,c.id);
  const bad=await fixture(t,{aiProvider:stub([operation('contact',{customer_id:{$ref:'customer1',sql:'SELECT 1'},name:'非法引用',phone:'13800001234'})])}),other=await bad.login(1);assert.equal((await receive(bad,other)).status,400);
});

test('真实模型省略不完整记录时仍显示缺失原因，未解决问题无法通过重新校验绕过',async t=>{
  const provider=stub([customer]);provider.prepare=async()=>({summary:'另一商机缺少金额',questions:['商机甲缺少预计金额，请补充。'],operations:[customer],model:AI_MODEL,usage:{}});
  const f=await fixture(t,{aiProvider:provider}),actor=await f.login(1),r=await receive(f,actor,'一批存在缺失的资料');
  assert.equal(r.body.valid,false);let b=await batch(f,actor,r.body.id);assert.match(b.errors[0].message,/缺少预计金额/);assert.equal((await confirm(f,actor,b)).status,422);
  await f.request(`/ai/batches/${b.id}/validate`,{actor,method:'POST',body:{}});b=await batch(f,actor,b.id);assert.match(b.errors[0].message,/缺少预计金额/);assert.equal((await confirm(f,actor,b)).status,422);
  assert.equal(one(f.db,"SELECT COUNT(*) n FROM customers WHERE name='AI隔离新客户'").n,0);
});

test('退役提成确认和发放类型不能经AI导入，历史记录保持原值',async t=>{
 for(const type of ['commission_confirm','commission_pay']) {
  const f=await fixture(t,{aiProvider:stub([operation(type,{sales_id:2,kind:'personal',period:quarter()})])}),actor=await f.login(1);
  const before=all(f.db,'SELECT * FROM commission_batches');
  const r=await receive(f,actor);assert.equal(r.status,400);assert.match(r.body.error,/不支持.*数据类型/);
  assert.deepEqual(all(f.db,'SELECT * FROM commission_batches'),before);
 }
});

test('退役骨架申请和审核类型均拒绝，不允许旧提案修改客户',async t=>{
  for(const type of ['change_request','change_request_review']) {
    const f=await fixture(t,{aiProvider:stub([operation(type,{entity:'customer',entity_id:1,fields:{name:'不应修改'},reason:'旧外部流程'})])}),actor=await f.login(1);
    const before=all(f.db,'SELECT id,name FROM customers ORDER BY id');
    const r=await receive(f,actor);assert.equal(r.status,400);assert.match(r.body.error,/不支持.*数据类型/);
    assert.deepEqual(all(f.db,'SELECT id,name FROM customers ORDER BY id'),before);assert.equal(one(f.db,'SELECT count(*) n FROM ai_import_batches').n,0);
  }
});

test('AI接收仅生成草稿；跨客户商机合同回款整批确认后正确持久化',async t=>{
  const operations=[customer,opportunity,operation('activity',{opportunity_id:'$opportunity1',summary:'客户确认需求',activity_type:'线上会议',activity_date:today()}),operation('quote',{opportunity_id:'$opportunity1',items:quoteItems(10000),valid_until:dateAdd(15)}),operation('contract',{opportunity_id:'$opportunity1',name:'AI合同',contract_no:'AI-TEST-001',sign_date:today(),items:[{name:'服务',kind:'标品',amount:10000}]}),archive(),operation('payment',{contract_id:'$contract1',amount:10000,status:'已到账',pay_date:today()})];
  const f=await fixture(t,{aiProvider:stub(operations)}),actor=await f.login(1);
  const before=one(f.db,'SELECT count(*) n FROM customers').n,rev=one(f.db,'SELECT revision FROM workspace_revision').revision;
  const response=await receive(f,actor,'已核对双方签章',{files:[signedFile()]});assert.equal(response.status,200);assert.equal(response.body.valid,true);
  assert.equal(one(f.db,'SELECT count(*) n FROM customers').n,before);assert.equal(one(f.db,'SELECT revision FROM workspace_revision').revision,rev);
  const b=await batch(f,actor,response.body.id);assert.deepEqual(b.errors,[]);
  assert.equal((await confirm(f,actor,b)).status,200);
  const state=(await f.request('/state',{actor})).body,c=state.contracts.find(c=>c.contract_no==='AI-TEST-001');
  assert.equal(c.amount,1000000);assert.equal(c.collected,1000000);assert.equal(c.outstanding,0);
  assert.equal(state.opportunities.find(o=>o.id===c.opportunity_id).stage,'赢单');
  assert.equal(one(f.db,'SELECT amount FROM targets WHERE user_id=2 AND quarter=?',quarter()).amount,150000000);
  assert.deepEqual(all(f.db,'PRAGMA foreign_key_check'),[]);
});

test('AI新增合同即签署，附件独立保存，已签署合同可同批登记回款',async t=>{
 const contractOp=operation('contract',{opportunity_id:'$opportunity1',name:'无签章归档合同',sign_date:today(),items:[{name:'授权',kind:'标品',amount:10000}]});
 const attachment=operation('contract_attachment',{contract_id:'$contract1',source_file:'双方签章.pdf'},{source_file:'双方签章.pdf'});
 const f=await fixture(t,{aiProvider:stub([customer,opportunity,contractOp,attachment,operation('payment',{contract_id:'$contract1',amount:10000,status:'已到账',pay_date:today()})])}),actor=await f.login(1);
 const response=await receive(f,actor,'保存已签署合同和独立附件',{files:[signedFile()]}),draft=await batch(f,actor,response.body.id);
 assert.deepEqual(draft.errors,[]);assert.equal((await confirm(f,actor,draft)).status,200);
 const c=one(f.db,"SELECT * FROM contracts WHERE name='无签章归档合同'");assert.equal(c.lifecycle,'已归档');assert.equal(c.archive_attachment_id,null);assert.equal(c.archived_at,null);
 assert.equal(one(f.db,'SELECT stage FROM opportunities WHERE id=?',c.opportunity_id).stage,'赢单');
 assert.equal(one(f.db,'SELECT count(*) n FROM payments WHERE contract_id=?',c.id).n,1);
 assert.equal(one(f.db,"SELECT count(*) n FROM attachments WHERE entity='contract' AND entity_id=?",c.id).n,1);
});

test('导入回执精确定位真实记录、原文件及时间，更新不改写旧回执且SQL视图可追溯',async t=>{
  const ops=[customer,operation('contact',{customer_id:'$customer1',name:'张工',phone:'13800001234'}),opportunity,operation('activity',{opportunity_id:'$opportunity1',summary:'确认技术范围',activity_type:'线上会议',activity_date:today()}),operation('quote',{opportunity_id:'$opportunity1',items:quoteItems(10000),valid_until:dateAdd(7)}),operation('contract',{opportunity_id:'$opportunity1',name:'可追溯合同',sign_date:today(),items:[{name:'软件实施',kind:'实施',amount:10000}]}),archive(),operation('payment',{contract_id:'$contract1',amount:10000,status:'已到账',pay_date:today()})];
  const provider=stub(ops.map(op=>({...op,source_file:op.type==='contract_archive'?'双方签章.pdf':'资料.md'}))),f=await fixture(t,{aiProvider:provider}),actor=await f.login(1);
  const file={name:'资料.md',base64:Buffer.from('隔离业务资料，回执核验').toString('base64')};
  const r=await receive(f,actor,'追溯测试',{files:[file,signedFile()]}),draft=await batch(f,actor,r.body.id);
  assert.deepEqual(draft.records,[]);assert.equal(draft.confirmed_at,null);
  const planned=(await f.request('/state',{actor})).body.ai.batches.find(b=>b.id===draft.id);
  assert.deepEqual(planned.destinations,[]);assert.ok(planned.planned_destinations.includes('客户档案'));assert.deepEqual(planned.files,['资料.md','双方签章.pdf']);
  assert.equal((await confirm(f,actor,draft)).status,200);
  const done=await batch(f,actor,draft.id);assert.equal(done.records.length,8);assert.ok(Date.parse(done.confirmed_at)>=Date.parse(done.created_at));
  const c=one(f.db,"SELECT id FROM customers WHERE name='AI隔离新客户'");
  const customerRecord=done.records.find(r=>r.type==='customer');assert.equal(customerRecord.record_id,c.id);assert.equal(customerRecord.detail_id,c.id);assert.equal(customerRecord.table,'customers');assert.equal(customerRecord.source_file,'资料.md');
  for(const record of done.records)assert.equal(record.imported_at,done.confirmed_at);
  const contract=done.records.find(r=>r.type==='contract');assert.equal(contract.related_records.length,1);assert.equal(one(f.db,'SELECT contract_id FROM contract_items WHERE id=?',contract.related_records[0].record_id).contract_id,contract.record_id);
  const view=all(f.db,'SELECT * FROM ai_import_records WHERE batch_id=?',done.id);assert.equal(view.length,8);assert.ok(view.every(r=>r.imported_at===done.confirmed_at));
  provider.prepare=stub([operation('customer',{name:'回执核验后改名'},{action:'update',target_id:c.id})]).prepare;
  const changed=await receive(f,actor,'更正已有客户名称'),preview=await batch(f,actor,changed.body.id);assert.equal((await confirm(f,actor,preview)).status,200);
  const updated=await batch(f,actor,changed.body.id);assert.equal(updated.records[0].action,'update');assert.equal(updated.records[0].record_id,c.id);
  assert.equal((await batch(f,actor,done.id)).records.find(r=>r.type==='customer').record_label,'AI隔离新客户');
  const history=(await f.request('/state',{actor})).body.ai.batches.find(b=>b.id===done.id);assert.equal(history.operation_count,8);assert.ok(history.destinations.some(d=>d.module==='customers'&&d.count===2));
});

test('旧回执兼容且不补造未知日期，导入历史按数据库权限筛选并保留最近50批',async t=>{
  const f=await fixture(t,{aiProvider:stub([customer])}),actor=await f.login(1),sales=await f.login(2);
  const r=await receive(f,actor),b=await batch(f,actor,r.body.id);await confirm(f,actor,b);
  const saved=await batch(f,actor,b.id);
  run(f.db,'UPDATE ai_import_batches SET result=?,confirmed_at=NULL WHERE id=?',JSON.stringify(saved.result.map(({type,ref,id,message})=>({type,ref,id,message}))),b.id);
  const old=await batch(f,actor,b.id);assert.equal(old.records[0].table,'customers');assert.equal(old.records[0].imported_at,null);
  assert.equal(one(f.db,'SELECT record_id FROM ai_import_records WHERE batch_id=?',b.id).record_id,saved.result[0].id);
  assert.equal((await f.request('/ai/batches/'+b.id,{actor:sales})).status,403);
  for(let i=0;i<55;i++)run(f.db,`INSERT INTO ai_import_batches(user_id,source_hash,state,summary,questions,operations,errors,model,usage,source_role,base_revision,created_at) VALUES(2,?,'draft','销售隔离批次','[]','[]','[]','test','{}','sales',0,?)`,'history-'+i,new Date().toISOString());
  const history=(await f.request('/state',{actor:sales})).body.ai.batches;
  assert.equal(history.length,50);assert.ok(history.every(b=>b.user_id===2&&b.source_role!=='admin'));assert.ok(history[0].id>history[49].id);
});

test('缺少字段逐项提示并禁止整批入库，不用默认值猜补',async t=>{
  const f=await fixture(t,{aiProvider:stub([customer,operation('opportunity',{name:'不完整商机',customer_id:'$customer1'})])}),actor=await f.login(1);
  const before=one(f.db,'SELECT count(*) n FROM customers').n;
  const r=await receive(f,actor);assert.equal(r.body.valid,false);const b=await batch(f,actor,r.body.id);
  assert.match(b.errors[0].message,/负责人/);assert.match(b.errors[0].message,/金额/);assert.match(b.errors[0].message,/销售类型/);assert.equal(b.errors[0].source_file,'粘贴内容');
  assert.equal((await confirm(f,actor,b)).status,422);assert.equal(one(f.db,'SELECT count(*) n FROM customers').n,before);
});

test('未来到账日、错误金额和无法匹配的关联阻止入库',async t=>{
  const ops=[operation('payment',{contract_id:1,amount:10,status:'已到账',pay_date:dateAdd(1)}),operation('quote',{opportunity_id:1,items:quoteItems(1.001),valid_until:today()},{ref:'quote2'}),operation('contact',{customer_name:'不存在的客户',phone:'13800001234',name:'某人'})];
  const f=await fixture(t,{aiProvider:stub(ops)}),actor=await f.login(1),r=await receive(f,actor,'跨文件资料',{files:[signedFile()]}),b=await batch(f,actor,r.body.id);
  assert.equal(b.errors.length,3);assert.match(b.errors.find(e=>e.ref==='payment1').message,/不能晚于今天/);assert.match(b.errors.find(e=>e.ref==='quote2').message,/两位小数/);assert.match(b.errors.find(e=>e.ref==='contact1').message,/唯一匹配/);
});

test('相同文件不重复调用模型、重复确认不产生重复客户',async t=>{
  let calls=0;const provider=stub([customer]);const prepare=provider.prepare;provider.prepare=async(...args)=>{calls++;return prepare(...args);};
  const f=await fixture(t,{aiProvider:provider}),actor=await f.login(1),file={name:'客户.md',base64:Buffer.from('客户资料').toString('base64')};
  const a=await receive(f,actor,'上传客户',{files:[file]}),b=await receive(f,actor,'上传客户',{files:[file]});assert.equal(a.body.id,b.body.id);assert.equal(calls,1);
  const row=await batch(f,actor,a.body.id),key=randomUUID();const x=await confirm(f,actor,row,{key}),y=await confirm(f,actor,row,{key});assert.equal(x.status,200);assert.deepEqual(y.body,x.body);
  assert.equal(one(f.db,"SELECT count(*) n FROM customers WHERE name='AI隔离新客户'").n,1);
  assert.equal((await confirm(f,actor,row)).status,409);
});

test('预览期间业务发生变化必须重新校验，未勾选确认不能提交',async t=>{
  const f=await fixture(t,{aiProvider:stub([customer])}),actor=await f.login(1),r=await receive(f,actor),b=await batch(f,actor,r.body.id);
  const noAck=await f.request(`/ai/batches/${b.id}/confirm`,{actor,method:'POST',body:{version:b.version}});assert.equal(noAck.status,400);
  run(f.db,"UPDATE customers SET note='其他用户更新' WHERE id=1");assert.equal((await confirm(f,actor,b)).status,409);
  assert.equal((await f.request(`/ai/batches/${b.id}/validate`,{actor,method:'POST',body:{}})).status,200);
  const refreshed=await batch(f,actor,b.id);assert.equal(refreshed.version,b.version+1);assert.equal((await confirm(f,actor,refreshed)).status,200);
});

test('AI同样遵守销售权限，不能修改他人客户或管理员配置',async t=>{
  const f=await fixture(t,{aiProvider:stub([operation('customer',{name:'越权改名'},{action:'update',target_id:2}),operation('document_template',{issuer:'越权模板主体',quote:'越权报价正文'})])}),actor=await f.login(2),other=await f.login(3);
  const r=await receive(f,actor),b=await batch(f,actor,r.body.id);assert.equal(b.errors.length,2);assert.match(b.errors[0].message,/无权/);assert.match(b.errors[1].message,/管理员/);
  assert.equal((await f.request(`/ai/batches/${b.id}`,{actor:other})).status,403);
  const state=(await f.request('/state',{actor})).body;assert.equal(state.integrationSettings,undefined);assert.equal(state.setup,undefined);
});

test('拒绝模型生成SQL、额外权限字段、未知动作；不持久化危险草稿',async t=>{
  for(const operations of [[operation('sql',{query:'DROP TABLE users'})],[operation('customer',{name:'危险',owner_id:2,developer_admin:1})]]) {
    const f=await fixture(t,{aiProvider:stub(operations)}),actor=await f.login(1);const r=await receive(f,actor);assert.equal(r.status,400);assert.equal(one(f.db,'SELECT count(*) n FROM ai_import_batches').n,0);
  }
});

test('补充缺失字段带回原附件，附件不向其他销售开放',async t=>{
  let latest;const provider=stub([customer]),prepare=provider.prepare;provider.prepare=async(b,...args)=>{latest=b;return prepare(b,...args);};
  const f=await fixture(t,{aiProvider:provider}),actor=await f.login(2),other=await f.login(3);
  const r=await receive(f,actor,'第一份资料',{context:{intent:'new-activity',id:1,label:'商机维护'},files:[{name:'原始.md',base64:Buffer.from('原始客户内容').toString('base64')}]}),b=await batch(f,actor,r.body.id);
  assert.equal((await f.request('/ai/files/'+b.files[0].id,{actor:other})).status,403);
  const next=await receive(f,actor,'补充：负责人为祝天',{previous_batch_id:b.id,context:{intent:'new-activity',id:99}});assert.equal(next.status,200);assert.equal(latest.files[0].name,'原始.md');assert.match(latest.text,/第一份资料/);assert.match(latest.text,/补充：负责人/);assert.equal(latest.context.id,1);
  assert.equal((await receive(f,other,'越权补充',{previous_batch_id:b.id})).status,403);
});

test('文档模板正文安全输出；未批准时始终为内部核对稿',async t=>{
  const f=await fixture(t,{aiProvider:stub([operation('document_template',{issuer:'测试公司',quote:'客户{{customer_name}} 金额{{amount}} <script>bad()</script>'})])}),actor=await f.login(1);
  const r=await receive(f,actor),b=await batch(f,actor,r.body.id);assert.equal((await confirm(f,actor,b)).status,200);
  const receipt=(await batch(f,actor,b.id)).records[0];assert.equal(receipt.table,'settings');assert.equal(receipt.record_key,'integrations');assert.equal(receipt.section,'documents');assert.equal(receipt.record_id,null);
  const quote=one(f.db,'SELECT id FROM quotes LIMIT 1');assert.ok(quote);
  const document=await f.request('/documents/quote/'+quote.id,{actor});assert.equal(document.status,200);assert.equal(document.body.official,false);assert.match(document.body.html,/&lt;script&gt;/);assert.doesNotMatch(document.body.html,/<script>/);
});

test('上传体积、类型、编码、密钥保护与未配置模型正确失败',async()=>{
  assert.doesNotThrow(()=>validateUpload({files:[{name:'大附件.pdf',base64:Buffer.alloc(1024*1024,65).toString('base64')}]}));
  for(const b of [{files:[{name:'脚本.exe',base64:'YQ=='}]},{files:[{name:'a.md',base64:'%$'}]},{text:'sk_'+ 'a'.repeat(32)},{files:[]}])assert.throws(()=>validateUpload(b));
  const ai=createIntakeAI({env:{}});await assert.rejects(()=>ai.prepare({text:'资料'},{}),/尚未配置/);
  for(const value of [{choices:[{finish_reason:'length',message:{content:'{}'}}]},{choices:[{finish_reason:'stop',message:{content:'not json'}}]}]) {
    const provider=createIntakeAI({env:{AI_API_KEY:'isolated-test-key'},fetcher:async()=>({ok:true,json:async()=>value})});
    await assert.rejects(()=>provider.prepare({text:'资料'},{today:today(),actor:{},records:{}}),/未完成|有效结构化/);
  }
});

test('数据库直接拒绝超额到账、非整数金额与跨客户错误合同关联',async t=>{
  const f=await fixture(t);
  assert.throws(()=>run(f.db,"UPDATE payments SET amount=999999999 WHERE contract_id=1 AND status='已到账'"),/integrity/);
  assert.throws(()=>run(f.db,'UPDATE contracts SET amount=0.5 WHERE id=1'),/integrity/);
  assert.throws(()=>run(f.db,'UPDATE opportunities SET customer_id=2 WHERE id=(SELECT opportunity_id FROM contracts WHERE id=1)'),/integrity/);
  assert.deepEqual(all(f.db,'PRAGMA foreign_key_check'),[]);
});

test('跨文件顺序不同仍按依赖关联新合同编号，不要求用户填写内部ID',async t=>{
  const ops=[operation('payment',{contract_no:'AI-ORDER-001',amount:10000,status:'已到账',pay_date:today()}),operation('contract',{opportunity_name:'AI隔离新商机',name:'乱序合同',contract_no:'AI-ORDER-001',sign_date:today(),items:[{name:'服务',kind:'标品',amount:10000}]}),archive(),opportunity,customer];
  const f=await fixture(t,{aiProvider:stub(ops)}),actor=await f.login(1),r=await receive(f,actor,'跨文件资料',{files:[signedFile()]}),b=await batch(f,actor,r.body.id);
  assert.deepEqual(b.errors,[]);assert.equal((await confirm(f,actor,b)).status,200);assert.equal(one(f.db,"SELECT SUM(p.amount) n FROM payments p JOIN contracts c ON p.contract_id=c.id WHERE c.contract_no='AI-ORDER-001'").n,1000000);
});

test('重新校验能重新匹配后来补齐的关联记录，保留原始识别字段',async t=>{
  const f=await fixture(t,{aiProvider:stub([operation('contact',{customer_name:'稍后补齐客户',phone:'13800001234',name:'联系人'})])}),actor=await f.login(1),r=await receive(f,actor),b=await batch(f,actor,r.body.id);assert.equal(b.errors.length,1);
  await f.request('/customers',{actor,method:'POST',body:{name:'稍后补齐客户',owner_id:1}});
  await f.request(`/ai/batches/${b.id}/validate`,{actor,method:'POST',body:{}});
  const after=await batch(f,actor,b.id);assert.deepEqual(after.errors,[]);assert.equal((await confirm(f,actor,after)).status,200);
});

test('明确更新不支持修改的记录会拒绝，不能误当新增造成重复计分',async t=>{
  const f=await fixture(t,{aiProvider:stub([operation('activity',{opportunity_id:1,summary:'改写跟进',activity_type:'线上会议',activity_date:today()},{action:'update',target_id:1})])}),actor=await f.login(1),r=await receive(f,actor),b=await batch(f,actor,r.body.id);
  assert.match(b.errors[0].message,/禁止把更新当作新增/);assert.equal((await confirm(f,actor,b)).status,422);
});

test('同一资料仅改文件名也能去重，重新校验不能绕过已入库附件保护',async t=>{
  let operations=[customer];const provider=stub([]);provider.prepare=async()=>({...await stub(operations).prepare()});
  const f=await fixture(t,{aiProvider:provider}),actor=await f.login(1),file={name:'a.md',base64:Buffer.from('相同原始资料').toString('base64')};
  const a=await receive(f,actor,'原始',{files:[file]}),b=await batch(f,actor,a.body.id);await confirm(f,actor,b);
  const same=await receive(f,actor,'原始',{files:[{...file,name:'b.md'}]});assert.equal(same.body.id,a.body.id);
  operations=[operation('customer',{name:'第二次误导入',owner_id:2})];
  const other=await receive(f,actor,'另一次说明',{files:[file]}),blocked=await batch(f,actor,other.body.id);assert.ok(blocked.errors.some(e=>/附件已有成功/.test(e.message)));
  await f.request(`/ai/batches/${blocked.id}/validate`,{actor,method:'POST',body:{}});const refreshed=await batch(f,actor,blocked.id);assert.ok(refreshed.errors.some(e=>/附件已有成功/.test(e.message)));
});

test('管理者降为销售后，旧管理资料的摘要和原文件都不再开放',async t=>{
  const f=await fixture(t,{aiProvider:stub([customer])}),actor=await f.login(1),r=await receive(f,actor),b=await batch(f,actor,r.body.id);
  run(f.db,"INSERT INTO users(name,username,role,created_at) VALUES('备用管理者','backup_admin','admin',?)",new Date().toISOString());run(f.db,"UPDATE users SET role='sales' WHERE id=1");
  assert.equal((await f.request('/ai/batches/'+b.id,{actor})).status,403);assert.equal((await f.request('/state',{actor})).body.ai.batches.length,0);
});

test('退役PPL快照和在线参数类型拒绝，原始资料不能偷偷重启外部镜像',async t=>{
  for(const type of ['ppl_snapshot','ppl_config']) {
    const f=await fixture(t,{aiProvider:stub([operation(type,{source_file:'ppl.json'})])}),actor=await f.login(1);
    const before=all(f.db,'SELECT id,name FROM opportunities ORDER BY id');
    const response=await receive(f,actor,'旧镜像资料',{files:[{name:'ppl.json',base64:Buffer.from('{}').toString('base64')}]});
    assert.equal(response.status,400);assert.match(response.body.error,/不支持.*数据类型/);
    assert.deepEqual(all(f.db,'SELECT id,name FROM opportunities ORDER BY id'),before);assert.equal(one(f.db,'SELECT count(*) n FROM ai_import_batches').n,0);
  }
});

test('AI网络等待不持有写事务，同人并发被限流，确认并发同键只执行一次',async t=>{
  let started,finish;const entered=new Promise(resolve=>started=resolve),waiting=new Promise(resolve=>finish=resolve);let calls=0;
  const provider=stub([customer]);provider.prepare=async()=>{calls++;started();await waiting;return stub([customer]).prepare();};
  const f=await fixture(t,{aiProvider:provider}),actor=await f.login(1);
  assert.equal((await receive(f,undefined,'未登录上传')).status,401);assert.equal(calls,0);
  const first=receive(f,actor,'第一批并发资料');await entered;
  try {
    assert.equal((await receive(f,actor,'第二批并发资料')).status,429);assert.equal(calls,1);
    assert.equal((await f.request('/customers',{actor,method:'POST',body:{name:'网络等待期间的独立更新',owner_id:1}})).status,200);
  } finally {finish();}
  const accepted=await first,b=await batch(f,actor,accepted.body.id);assert.deepEqual(b.errors,[]);
  const key=randomUUID(),responses=await Promise.all([confirm(f,actor,b,{key}),confirm(f,actor,b,{key})]);assert.ok(responses.every(r=>r.status===200));assert.deepEqual(responses[0].body,responses[1].body);assert.equal(one(f.db,"SELECT COUNT(*) n FROM customers WHERE name='AI隔离新客户'").n,1);
});
