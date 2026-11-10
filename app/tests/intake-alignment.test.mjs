import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/fixture.mjs';
import {all,one} from '../server/database.mjs';
import {today,dateAdd} from '../server/domain.mjs';
import {AI_MODEL} from '../server/ai-intake.mjs';
import {intakeCatalog} from '../server/modules/ai-imports.mjs';
import {intakeSchema,intakeStorage,operationFields,allowedIntakeActions,schemaForAI} from '../public/modules/intake-schema.js';

const quoteItems=amount=>[{name:'测试授权',kind:'标品',quantity:1,list_price:amount,discount_rate:1}];
const signedFile=()=>({name:'双方签章.pdf',base64:Buffer.from('%PDF-1.7\nSynthetic isolated attachment').toString('base64')});
const op=(type,data,extra={})=>({type,action:'create',ref:type+'1',data,source_file:'粘贴内容',evidence:'随机隔离业务资料',...extra});
const provider=()=>({configured:true,model:AI_MODEL,operations:[],async prepare(){return {summary:'隔离校验',questions:[],operations:this.operations,model:AI_MODEL,usage:{},sources:[]};}});
async function receive(f,actor,ai,operations,body={}) {
  ai.operations=operations;
  const result=await f.request('/ai/intake',{actor,method:'POST',body:{text:'隔离批次 '+randomUUID(),...body}});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const batch=await f.request('/ai/batches/'+result.body.id,{actor});assert.equal(batch.status,200);
  return batch.body;
}
const confirm=(f,actor,batch)=>f.request(`/ai/batches/${batch.id}/confirm`,{actor,method:'POST',body:{version:batch.version,acknowledged:true}});
const opportunity=(name,extra={})=>({customer_id:1,name,owner_id:2,stage:'需求',amount:12345.67,product_amount:0,sale_type:'新签分发',order_type:'代销',next_action:'确认范围',follow_date:dateAdd(3),...extra});

test('每个AI字段都有真实SQLite列或明确控制用途，角色动作与现有写入权限一致',async t=>{
  const f=await fixture(t),tables=new Map();
  assert.deepEqual(Object.keys(intakeStorage).sort(),Object.keys(intakeSchema).sort());
  for(const [type,def] of Object.entries(intakeSchema)) {
    assert.deepEqual(Object.keys(intakeStorage[type]).sort(),def.fields.split(' ').sort(),type);
    for(const [field,mapping] of Object.entries(intakeStorage[type])) {
      assert.ok(['stored','derived','control'].includes(mapping.kind),type+'.'+field);
      if(mapping.kind==='control'){assert.ok(mapping.purpose);continue;}
      assert.ok(mapping.targets.length,type+'.'+field);
      for(const target of mapping.targets) {
        if(!tables.has(target.table))tables.set(target.table,new Set(all(f.db,`PRAGMA table_info(${target.table})`).map(c=>c.name)));
        assert.ok(tables.get(target.table).has(target.column),`${type}.${field} → ${target.table}.${target.column}`);
        if(target.key)assert.equal(target.table,'settings');
      }
    }
  }
  assert.deepEqual(allowedIntakeActions('contract','sales'),['create','update']);
  assert.deepEqual(allowedIntakeActions('contract','pm'),['update']);
  assert.deepEqual(operationFields('contract','update','pm'),['scope','project_status','delivery_staff','project_note']);
  assert.deepEqual(allowedIntakeActions('payment','admin'),['create']);
  assert.deepEqual(allowedIntakeActions('ppl_snapshot','admin'),[]);assert.deepEqual(allowedIntakeActions('contract_archive','admin'),['create','update']);
  assert.deepEqual(allowedIntakeActions('customer','pm'),[]);
  assert.ok(operationFields('contract','update','admin').includes('sale_type'));
  assert.ok(operationFields('contract','update','admin').includes('order_type'));
  assert.ok(operationFields('contract','update','admin').includes('owner_id'));
  assert.ok(operationFields('contract','update','admin').includes('reason'));
  assert.ok(operationFields('opportunity','update','admin').includes('customer_id'));
  assert.deepEqual(schemaForAI().contact.required_one_of_for_create,[['phone','wechat','dingtalk']]);
  assert.deepEqual(schemaForAI().quote.items_schema.required,['name','kind','quantity','list_price']);
  const reaches=(type,field,table,column)=>intakeStorage[type][field].targets.some(t=>t.table===table&&t.column===column);
  assert.ok(reaches('contract','items','contracts','amount'));
  for(const field of ['renewal_tag','payment_type','project_status','delivery_staff','project_note'])assert.ok(reaches('contract',field,'contracts',field),field);
  assert.ok(reaches('activity','activity_date','activity_events','activity_date'));
  assert.ok(reaches('payment_receive','pay_date','payments','status'));
  assert.ok(reaches('contract_archive','both_stamped','opportunities','amount'));
  assert.ok(reaches('member','ding_union_id','ding_identities','user_id'));
});

test('本批引用核对对象类型，数字编号重合也不能把客户当合同',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1);
  const before=one(f.db,'SELECT note FROM customers WHERE id=1').note;
  const batch=await receive(f,actor,ai,[op('customer',{note:'不应被部分提交'},{action:'update',target_id:1,ref:'customerReference'}),op('payment',{contract_id:'$customerReference',amount:1,status:'已到账',pay_date:today()})]);
  assert.ok(batch.errors.some(error=>/须关联合同，不能关联客户/.test(error.message)));
  assert.equal((await confirm(f,actor,batch)).status,422);
  assert.equal(one(f.db,'SELECT note FROM customers WHERE id=1').note,before);
});

test('模型新增记录的空目标按缺省处理，零布尔空字符串和已有目标不能误作新建',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1);
  const batch=await receive(f,actor,ai,[op('customer',{name:'空目标客户'+randomUUID(),owner_id:2},{target_id:null})]);
  assert.deepEqual(batch.errors,[]);assert.equal(batch.operations[0].target_id,undefined);assert.equal((await confirm(f,actor,batch)).status,200);
  for(const target_id of [0,false,'']) {
    ai.operations=[op('customer',{name:'无效目标客户'+randomUUID(),owner_id:2},{target_id})];
    const result=await f.request('/ai/intake',{actor,method:'POST',body:{text:'目标校验'+randomUUID()}});
    assert.equal(result.status,400);assert.match(result.body.error,/目标记录ID无效/);
  }
  const existing=await receive(f,actor,ai,[op('customer',{name:'误用既有目标'+randomUUID(),owner_id:2},{target_id:1})]);
  assert.match(existing.errors[0].message,/新增记录不能同时指定已有记录编号/);assert.equal((await confirm(f,actor,existing)).status,422);
});

test('兼容真实Qwen协作PM姓名输出，重校验保留原附件并只精确匹配授权成员',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1);
  const pm=await f.request('/users',{actor,method:'POST',body:{name:'验收协作PM',username:'intake_verified_pm',role:'pm',dingtalk_only:true}});assert.equal(pm.status,200);
  // Regression shape copied from the paid Qwen response, containing synthetic acceptance data only.
  const raw={type:'opportunity',action:'create',ref:'opportunity1',source_file:'随机业务资料-4720edad.md',data:{customer_id:'$customer1',name:'设备协同实施4720edad',owner_id:2,stage:'需求',amount:77976,product_amount:30000,sale_type:'新签自建',order_type:'千帆',next_action:'核对实施边界并提交交付计划',follow_date:'2026-11-12',collaborator_pm:'验收协作PM'},evidence:'协作PM：验收协作PM'};
  const files=[{name:raw.source_file,base64:Buffer.from('合成验收资料：协作PM为验收协作PM').toString('base64')}];
  let batch=await receive(f,actor,ai,[op('customer',{name:'宁波禾序4720edad科技有限公司',owner_id:2},{source_file:raw.source_file}),raw],{files});
  assert.deepEqual(batch.errors,[]);assert.equal(batch.operations.find(entry=>entry.type==='opportunity').data.collaborator_pm,pm.body.id);
  assert.equal((await f.request(`/ai/batches/${batch.id}/validate`,{actor,method:'POST',body:{}})).status,200);
  batch=(await f.request('/ai/batches/'+batch.id,{actor})).body;assert.deepEqual(batch.errors,[]);assert.equal(batch.operations.find(entry=>entry.type==='opportunity').input_data.collaborator_pm,'验收协作PM');
  assert.equal((await confirm(f,actor,batch)).status,200);assert.equal(one(f.db,'SELECT collaborator_pm FROM opportunities WHERE name=?',raw.data.name).collaborator_pm,pm.body.id);
  batch=await receive(f,actor,ai,[op('opportunity',opportunity('通过账号关联PM',{collaborator_pm:'intake_verified_pm'}))]);assert.deepEqual(batch.errors,[]);
  const duplicate=await f.request('/users',{actor,method:'POST',body:{name:'验收协作PM',username:'intake_other_pm',role:'pm',dingtalk_only:true}});assert.equal(duplicate.status,200);
  batch=await receive(f,actor,ai,[op('opportunity',opportunity('同名PM不得猜选',{collaborator_pm:'验收协作PM'}))]);assert.match(batch.errors[0].message,/无法唯一匹配/);
  const salesName=one(f.db,'SELECT name FROM users WHERE id=2').name;
  batch=await receive(f,actor,ai,[op('opportunity',opportunity('销售不得冒充PM',{collaborator_pm:salesName}))]);assert.match(batch.errors[0].message,/协作PM无效/);
  batch=await receive(f,actor,ai,[op('opportunity',opportunity('不做模糊匹配',{collaborator_pm:'验收协作'}))]);assert.match(batch.errors[0].message,/无法唯一匹配/);
});

test('客户协作成员列表支持姓名账号和本批成员引用，保留管理员授权与类型校验',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1),sales=await f.login(2);
  const member=one(f.db,'SELECT id,name,username FROM users WHERE id=3');
  let batch=await receive(f,actor,ai,[op('customer',{collaborators:[member.name,member.username]},{action:'update',target_id:1})]);assert.deepEqual(batch.errors,[]);assert.equal((await confirm(f,actor,batch)).status,200);
  assert.deepEqual(all(f.db,'SELECT user_id FROM customer_collaborators WHERE customer_id=1').map(row=>row.user_id),[3]);
  batch=await receive(f,actor,ai,[op('member',{name:'新建业务协作人',username:'intake_new_collaborator',role:'pm'},{ref:'newCollaborator'}),op('customer',{collaborators:['$newCollaborator']},{action:'update',target_id:1})]);assert.deepEqual(batch.errors,[]);assert.equal((await confirm(f,actor,batch)).status,200);
  const created=one(f.db,"SELECT id FROM users WHERE username='intake_new_collaborator'");assert.deepEqual(all(f.db,'SELECT user_id FROM customer_collaborators WHERE customer_id=1').map(row=>row.user_id),[created.id]);
  batch=await receive(f,sales,ai,[op('customer',{collaborators:[member.name]},{action:'update',target_id:1})]);assert.ok(batch.errors.some(error=>/管理员/.test(error.message)));assert.equal((await confirm(f,sales,batch)).status,422);
  batch=await receive(f,actor,ai,[op('customer',{note:'只用于引用校验'},{action:'update',target_id:1,ref:'wrongType'}),op('customer',{collaborators:['$wrongType']},{action:'update',target_id:2,ref:'updateOther'})]);assert.ok(batch.errors.some(error=>/须引用团队成员/.test(error.message)));
  for(const value of [true,0,'未知成员']){batch=await receive(f,actor,ai,[op('customer',{collaborators:[value]},{action:'update',target_id:1})]);assert.ok(batch.errors.some(error=>/无法唯一匹配/.test(error.message)));}
});

test('关联名称与ID必须一致，同名新记录不能最后一条覆盖，合同名不能冒充合同编号',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1);
  let batch=await receive(f,actor,ai,[op('contact',{customer_id:1,customer_name:one(f.db,'SELECT name FROM customers WHERE id=2').name,name:'冲突联系人',phone:'13800001234'})]);
  assert.match(batch.errors[0].message,/名称与编号不一致/);
  const name='同名商机'+randomUUID();
  batch=await receive(f,actor,ai,[op('opportunity',opportunity(name),{ref:'opA'}),op('opportunity',opportunity(name,{customer_id:2}),{ref:'opB'}),op('quote',{opportunity_name:name,items:quoteItems(123),valid_until:dateAdd(10)})]);
  assert.ok(batch.errors.some(error=>/无法唯一匹配/.test(error.message)));
  batch=await receive(f,actor,ai,[op('contract',{customer_id:1,name:'只有合同名称',sign_date:today(),items:[{name:'授权',kind:'标品',amount:10}]}),op('payment',{contract_no:'只有合同名称',amount:1,status:'已到账',pay_date:today()})]);
  assert.ok(batch.errors.some(error=>/无法唯一匹配/.test(error.message)));
  const matching=await receive(f,actor,ai,[op('contact',{customer_id:1,customer_name:one(f.db,'SELECT name FROM customers WHERE id=1').name,name:'一致联系人',phone:'13800001234'})]);
  assert.deepEqual(matching.errors,[]);assert.equal((await confirm(f,actor,matching)).status,200);
});

test('空操作、被忽略字段、模糊布尔和错误数字关系均阻止确认',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1);
  const cases=[
    op('customer',{}, {action:'update',target_id:1}),
    op('customer',{reason:'只有原因'}, {action:'update',target_id:1}),
    op('customer',{name:'误用目标编号'+randomUUID(),owner_id:2},{target_id:1}),
    op('contact',{customer_id:true,name:'布尔编号',phone:'13800001234'}),
    op('contact',{active:'false'},{action:'update',target_id:1}),
    op('opportunity',{lost_reason:'未注明流失'},{action:'update',target_id:1}),
    op('rules',{thresholds:[]}),
    op('rules',{commission:{}}),
    op('customer',{name:'空负责人'+randomUUID(),owner_id:'   '}),
  ];
  for(const entry of cases){const batch=await receive(f,actor,ai,[entry]);assert.ok(batch.errors.length,JSON.stringify(entry));assert.equal((await confirm(f,actor,batch)).status,422);}
});

test('回执只允许本批来源，阶段和财务规则按实际修改内容定位',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1);
  const files=[{name:'实际资料.md',base64:Buffer.from('真实原附件').toString('base64')}];
  let batch=await receive(f,actor,ai,[op('customer',{name:'虚构来源客户',owner_id:2},{source_file:'不存在.pdf'})],{files});
  assert.match(batch.errors[0].message,/来源不在本批附件/);assert.equal((await confirm(f,actor,batch)).status,422);
  batch=await receive(f,actor,ai,[op('rules',{thresholds:{'需求':8},performance:{cap:50}},{source_file:'实际资料.md'})],{files});
  assert.deepEqual(batch.errors,[]);assert.equal((await confirm(f,actor,batch)).status,200);
  const done=(await f.request('/ai/batches/'+batch.id,{actor})).body;
  assert.deepEqual(done.records.map(record=>record.view),['opportunities','performance']);assert.ok(done.records.every(record=>record.source_file==='实际资料.md'&&record.record_key==='rules'&&record.imported_at===done.confirmed_at));
});

test('已有公司模板只修改明确字段，未完成模板不能伪装成完整更新',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1);
  let batch=await receive(f,actor,ai,[op('document_template',{quote:'缺少签约主体'},{action:'update'})]);
  assert.ok(batch.errors.some(error=>/主体|完整/.test(error.message)));
  batch=await receive(f,actor,ai,[op('document_template',{issuer:'测试签约公司',quote:'报价正文 {{amount}}'})]);
  assert.deepEqual(batch.errors,[]);assert.equal((await confirm(f,actor,batch)).status,200);
  batch=await receive(f,actor,ai,[op('document_template',{quote:'修订报价正文 {{amount}}'},{action:'update'})]);
  assert.deepEqual(batch.errors,[]);assert.equal((await confirm(f,actor,batch)).status,200);
  const saved=JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='integrations'").value);
  assert.equal(saved.documents.issuer,'测试签约公司');assert.equal(saved.documents.quote,'修订报价正文 {{amount}}');assert.equal(saved.documents.confirmed,false);
});

test('随机完整业务资料经过确认后写入对应列，派生字段、关联明细与目录均可追溯',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1),tag=randomUUID().slice(0,8);
  const customer={name:'智研商贸'+tag,owner_id:2,short_name:'智研'+tag,industry:'研发服务',region:'深圳',manual_level:'A',credit_code:'TEST'+tag,scale:'50人',note:'业务资料'+tag,parent_company:'母公司'+tag,group_name:'集团'+tag,tags:'重点,科技',compliance_flag:'已核验'};
  const contact={customer_id:'$customer1',name:'陈工'+tag,title:'技术负责人',phone:'13800001234',role:'决策人',attitude:'支持',wechat:'wx'+tag,dingtalk:'业务备注'+tag,last_contact:today(),note:'确认范围'};
  const opportunityData=opportunity('智研采购'+tag,{customer_id:'$customer1',product_amount:7654.32,expected_date:dateAdd(30)});
  const contractData={customer_id:'$customer1',name:'正式业务合同'+tag,sign_date:today(),valid_until:dateAdd(365),contract_no:'TEST-'+tag,scope:'交付授权和培训',items:[{name:'授权许可',kind:'标品',amount:12345.67,man_days:3.25,payment_date:dateAdd(20),valid_until:dateAdd(365)}]};
  const batch=await receive(f,actor,ai,[op('customer',customer),op('contact',contact),op('opportunity',opportunityData),op('activity',{opportunity_id:'$opportunity1',summary:'技术会'+tag,action:'准备方案',activity_type:'线上会议',source:'手动',activity_date:today(),follow_date:dateAdd(6)}),op('quote',{opportunity_id:'$opportunity1',items:quoteItems(12345.67),valid_until:dateAdd(15),note:'正式报价'}),op('contract',contractData),op('contract_archive',{contract_id:'$contract1',source_file:'双方签章.pdf',both_stamped:true},{source_file:'双方签章.pdf'}),op('payment',{contract_id:'$contract1',amount:123.45,status:'待到账',promise_date:dateAdd(20),checkpoint_date:dateAdd(18),note:'首期计划'})],{files:[signedFile()]});
  assert.deepEqual(batch.errors,[]);assert.equal(one(f.db,'SELECT count(*) n FROM customers WHERE name=?',customer.name).n,0);assert.equal((await confirm(f,actor,batch)).status,200);
  const done=(await f.request('/ai/batches/'+batch.id,{actor})).body,ids=Object.fromEntries(done.result.map(result=>[result.type,result.id]));
  const c=one(f.db,'SELECT * FROM customers WHERE id=?',ids.customer);for(const [key,value] of Object.entries(customer))assert.equal(c[key],key==='credit_code'?value.toUpperCase():value,key);
  const p=one(f.db,'SELECT * FROM contacts WHERE id=?',ids.contact);for(const [key,value] of Object.entries(contact))assert.equal(p[key],key==='customer_id'?ids.customer:value,key);
  const o=one(f.db,'SELECT * FROM opportunities WHERE id=?',ids.opportunity);assert.equal(o.amount,1234567);assert.equal(o.product_amount,765432);assert.equal(o.sale_type,'新签分发');assert.equal(o.order_type,'代销');assert.equal(o.next_action,'准备方案');assert.equal(o.follow_date,dateAdd(6));
  const contract=one(f.db,'SELECT * FROM contracts WHERE id=?',ids.contract);assert.equal(contract.customer_id,ids.customer);assert.equal(contract.amount,1234567);assert.equal(Object.hasOwn(contract,'recurring_amount'),false);assert.equal(Object.hasOwn(contract,'auto_renew'),false);
  const item=one(f.db,'SELECT * FROM contract_items WHERE contract_id=?',ids.contract);assert.equal(item.man_days,3.25);assert.equal(item.payment_date,dateAdd(20));assert.equal(item.amount,1234567);
  const payment=one(f.db,'SELECT * FROM payments WHERE id=?',ids.payment);assert.equal(payment.contract_id,ids.contract);assert.equal(payment.amount,12345);assert.equal(payment.promise_date,dateAdd(20));assert.equal(payment.checkpoint_date,dateAdd(18));
  const catalog=intakeCatalog((await f.request('/state',{actor})).body);assert.ok(catalog.records.contacts.some(record=>record.id===ids.contact));assert.ok(catalog.records.contracts.find(record=>record.id===ids.contract).items.some(record=>record.id===item.id));
  assert.deepEqual(all(f.db,'PRAGMA foreign_key_check'),[]);assert.equal(one(f.db,'PRAGMA integrity_check').integrity_check,'ok');
});

test('AI可补已有合同分类并有原因移交负责人，历史未知值不被补造且PM边界不扩大',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1);
  const created=await f.request('/contracts',{actor,method:'POST',body:{customer_id:1,owner_id:2,name:'隔离历史合同',sign_date:today(),items:[{name:'许可',kind:'标品',amount:123.45}]}});
  assert.equal(created.status,200);const id=created.body.id;
  f.db.prepare("UPDATE contracts SET lifecycle='历史登记',project_status=NULL WHERE id=?").run(id);
  const workflow={name:'已核对的合同名称',sale_type:'续费',renewal_tag:'新签（分发）',payment_type:'千帆收款'};
  let batch=await receive(f,actor,ai,[op('contract',workflow,{action:'update',target_id:id})]);assert.deepEqual(batch.errors,[]);assert.equal((await confirm(f,actor,batch)).status,200);
  for(const [field,value] of Object.entries(workflow))assert.equal(one(f.db,'SELECT * FROM contracts WHERE id=?',id)[field],value,field);
  assert.deepEqual({...one(f.db,'SELECT sale_type,order_type,project_status FROM contracts WHERE id=?',id)},{sale_type:'续费',order_type:null,project_status:null});
  batch=await receive(f,actor,ai,[op('contract',{owner_id:3},{action:'update',target_id:id})]);assert.ok(batch.errors.some(e=>/归属调整原因/.test(e.message)));assert.equal((await confirm(f,actor,batch)).status,422);
  const reason='管理者明确移交该历史合同';batch=await receive(f,actor,ai,[op('contract',{owner_id:3,order_type:'经销',reason},{action:'update',target_id:id})]);assert.deepEqual(batch.errors,[]);assert.equal((await confirm(f,actor,batch)).status,200);
  assert.equal(one(f.db,'SELECT owner_id FROM contracts WHERE id=?',id).owner_id,3);
  assert.equal(JSON.parse(one(f.db,"SELECT detail FROM audit WHERE entity='contract' AND entity_id=? AND action='更新合同' ORDER BY id DESC LIMIT 1",id).detail).reason,reason);
  const member=await f.request('/users',{actor,method:'POST',body:{name:'隔离合同PM',username:'alignment_contract_pm',role:'pm',dingtalk_only:true}});assert.equal(member.status,200);
  f.db.prepare('UPDATE contracts SET collaborator_pm=? WHERE id=?').run(member.body.id,id);const pm=await f.login(member.body.id);
  const delivery={scope:'PM明确维护交付范围',project_status:'交付中',delivery_staff:'研发张工',project_note:'等待客户验收安排'};
  batch=await receive(f,pm,ai,[op('contract',delivery,{action:'update',target_id:id})]);assert.deepEqual(batch.errors,[]);assert.equal((await confirm(f,pm,batch)).status,200);
  for(const [field,value] of Object.entries(delivery))assert.equal(one(f.db,'SELECT * FROM contracts WHERE id=?',id)[field],value,field);
  for(const forbidden of [{sale_type:'增购'},{renewal_tag:'经销品'},{payment_type:'客户直付天元'},{owner_id:2}]){
    batch=await receive(f,pm,ai,[op('contract',forbidden,{action:'update',target_id:id})]);assert.ok(batch.errors.length);assert.equal((await confirm(f,pm,batch)).status,422);
  }
  assert.equal(one(f.db,'SELECT sale_type FROM contracts WHERE id=?',id).sale_type,'续费');
});

test('AI修改商机关联客户复用后端限制，已有合同不得换客户',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1);
  const created=await f.request('/opportunities',{actor,method:'POST',body:opportunity('可核对客户归属的商机')});assert.equal(created.status,200);const id=created.body.id;
  let batch=await receive(f,actor,ai,[op('opportunity',{customer_id:2},{action:'update',target_id:id})]);assert.deepEqual(batch.errors,[]);assert.equal((await confirm(f,actor,batch)).status,200);assert.equal(one(f.db,'SELECT customer_id FROM opportunities WHERE id=?',id).customer_id,2);
  const contract=await f.request('/contracts',{actor,method:'POST',body:{opportunity_id:id,name:'锁定关联合同',sign_date:today(),items:[{name:'服务',kind:'实施',amount:100}]}});assert.equal(contract.status,200);
  batch=await receive(f,actor,ai,[op('opportunity',{customer_id:1},{action:'update',target_id:id})]);assert.ok(batch.errors.some(e=>/已有关联合同/.test(e.message)));assert.equal((await confirm(f,actor,batch)).status,422);assert.equal(one(f.db,'SELECT customer_id FROM opportunities WHERE id=?',id).customer_id,2);
});

test('报价与合同嵌套字段不可静默丢弃，缺报价类型按中文提示且整批不写入',async t=>{
  const ai=provider(),f=await fixture(t,{aiProvider:ai}),actor=await f.login(1);
  const before={quotes:one(f.db,'SELECT COUNT(*) n FROM quotes').n,contracts:one(f.db,'SELECT COUNT(*) n FROM contracts').n,customers:one(f.db,'SELECT COUNT(*) n FROM customers').n};
  const quote={opportunity_id:1,valid_until:dateAdd(7),items:quoteItems(100)};
  const contract={customer_id:1,name:'非法额外字段合同',sign_date:today(),items:[{name:'服务',kind:'实施',amount:100}]};
  for(const [type,body] of [['quote',quote],['contract',contract]]){
    const invalid={...body,items:body.items.map(i=>({...i,unapproved_field:'不得丢弃后继续入库'}))};
    const direct=await f.request(type==='quote'?'/quotes':'/contracts',{actor,method:'POST',body:invalid});assert.equal(direct.status,400);assert.match(direct.body.error,/不支持字段/);
    const batch=await receive(f,actor,ai,[op('customer',{name:'不得部分入库'+randomUUID(),owner_id:2}),op(type,invalid)]);assert.ok(batch.errors.some(e=>/不支持字段/.test(e.message)));assert.equal((await confirm(f,actor,batch)).status,422);
  }
  const missingKind={...quote,items:quote.items.map(({kind,...item})=>item)},batch=await receive(f,actor,ai,[op('quote',missingKind)]);
  assert.ok(batch.errors.some(e=>/报价明细缺少：类型/.test(e.message)));assert.equal((await confirm(f,actor,batch)).status,422);
  for(const invalid of [null,[],false])assert.equal((await f.request('/contracts',{actor,method:'POST',body:{...contract,items:[invalid]}})).status,400);
  assert.deepEqual({quotes:one(f.db,'SELECT COUNT(*) n FROM quotes').n,contracts:one(f.db,'SELECT COUNT(*) n FROM contracts').n,customers:one(f.db,'SELECT COUNT(*) n FROM customers').n},before);
});
