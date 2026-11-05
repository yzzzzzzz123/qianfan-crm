import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {fixture,customer,opp} from './helpers/fixture.mjs';
import {one,run} from '../server/database.mjs';
import {createCompanyProfileProvider,normalizeCompanyName,normalizeCreditCode,COMPANY_PROFILE_ENDPOINT} from '../server/company-profile.mjs';
import {createSalesAdviceAI,SALES_ADVICE_SYSTEM} from '../server/sales-advice.mjs';
import {companyProfileDetails} from '../public/modules/customers.js';

const advice=()=>({stage_assessment:'当前需求阶段需要核实决策过程；没有客户预算证据。',next_actions:[1,2,3].map(i=>({priority:'高',action:'与客户业务负责人核对目标'+i,purpose:'明确真实需求',timing:'下次会议前',success_signal:'客户确认书面问题清单'})),talk_tracks:[1,2].map(i=>({scenario:'需求访谈'+i,script:'为了确认本次范围，您希望通过项目改善哪项业务指标？'})),materials:['现有需求与待核实问题清单','本次产品演示及验证标准'],risks:['未确认预算，不承诺交付条件'],information_gaps:['尚未核实决策人及预算'],cautions:['企业人数未提供，保持未知']});
const profile=(name='核验客户有限公司')=>({state:'ready',details:{company_name:name,employee_scale:'100–199人',business_scope:'源登记经营范围',main_business:null},reason:'仅展示源接口提供的事实'});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function makeOpp(f,actor,extra={}){const created=await f.request('/customers',{actor,method:'POST',body:customer({name:'独立商机分析企业'+randomUUID()})});assert.equal(created.status,200);const r=await f.request('/opportunities',{actor,method:'POST',body:opp(created.body.id,{name:'已维护售卖产品 R1',...extra})});assert.equal(r.status,200);return {cid:created.body.id,oid:r.body.id};}

test('客户规范化全称/信用代码查重，确认疑似重复不能绕过精确重复，旧档案不合并',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  assert.equal(normalizeCompanyName('ＡＢＣ（华东） 有限公司'),'abc华东有限公司');
  assert.equal(normalizeCreditCode(' ９１３Ａｂ\u200bｃ '),'913ABC');
  const first=await f.request('/customers',{actor,method:'POST',body:customer({name:'ＡＢＣ（华东） 有限公司',credit_code:'９１３ＡＢＣ'})});assert.equal(first.status,200);
  for(const body of [customer({name:'ABC(华东)有限公司',duplicate_ack:true}),customer({name:'完全不同名称的企业',credit_code:'913abc',duplicate_ack:true})]){
    const result=await f.request('/customers',{actor,method:'POST',body});assert.equal(result.status,409);
  }
  const other=await f.request('/customers',{actor,method:'POST',body:customer({name:'无需合并的企业'})});assert.equal(other.status,200);
  assert.equal((await f.request('/customers/'+other.body.id,{actor,method:'PATCH',body:{credit_code:'９１３ａｂｃ'}})).status,409);
  assert.equal(one(f.db,'SELECT credit_code FROM customers WHERE id=?',other.body.id).credit_code,'');
  assert.equal(one(f.db,'SELECT name FROM customers WHERE id=?',first.body.id).name,'ＡＢＣ（华东） 有限公司');
});

test('未接入企业接口时新客户仍创建，独立详细信息明确未配置，不调用任何模型',async t=>{
  let called=0;const f=await fixture(t,{companyProfileProvider:{configured:false,lookup(){called++;}},salesAdviceProvider:{configured:true,model:'test',analyze(){called++;}}}),actor=await f.login(1);
  const r=await f.request('/customers',{actor,method:'POST',body:customer()});assert.equal(r.status,200);assert.equal(called,0);
  const state=(await f.request('/state',{actor})).body;assert.equal(state.customers.find(c=>c.id===r.body.id).company_profile.state,'not_configured');assert.equal(called,0);
  assert.deepEqual(JSON.parse(one(f.db,'SELECT details FROM customer_profiles WHERE customer_id=?',r.body.id).details),{});
});

test('企查查适配只发送主体查询，固定官方地址与签名，未知主营不由经营范围猜造',async()=>{
  let calls=0;
  const provider=createCompanyProfileProvider({env:{CRM_COMPANY_PROFILE_PROVIDER:'qcc',QCC_APP_KEY:'fixture-key',QCC_SECRET_KEY:'fixture-secret'},clock:()=>1700000000000,fetcher:async(url,options)=>{
    calls++;assert.equal(url.origin+url.pathname,COMPANY_PROFILE_ENDPOINT);assert.equal(url.searchParams.get('searchKey'),'913ABC');assert.equal(options.headers.Timespan,'1700000000');assert.equal(options.headers.Token,createHash('md5').update('fixture-key1700000000fixture-secret').digest('hex').toUpperCase());assert.equal(options.redirect,'error');
    return new Response(JSON.stringify({Status:'200',Result:{Name:'核验企业',CreditCode:'913ABC',Scope:'真实登记内容',PersonScope:'100-199人',InsuredCount:'100'}}));
  }});
  const value=await provider.lookup({name:'核验企业',credit_code:'913abc',note:'不应发送的内部资料'});assert.equal(calls,1);assert.equal(value.state,'ready');assert.equal(value.details.main_business,null);assert.equal(value.details.business_scope,'真实登记内容');
  const mismatch=await provider.lookup({name:'不是该企业',credit_code:'913abc'});assert.equal(mismatch.state,'mismatch');assert.deepEqual(mismatch.details,{});
  const disabled=createCompanyProfileProvider({env:{QCC_APP_KEY:'fixture',QCC_SECRET_KEY:'fixture'},fetcher:()=>{throw new Error('不应外发');}});assert.equal(disabled.configured,false);
});

test('创建后的企业查询在提交后运行且幂等，来源信息独立展示并按客户权限隐藏',async t=>{
  let f,calls=0;f=await fixture(t,{companyProfileProvider:{configured:true,provider:'隔离可信接口',sourceUrl:'https://example.invalid/docs',lookup:async c=>{calls++;assert.equal(f.db.isTransaction,false);assert(one(f.db,'SELECT id FROM customers WHERE name=?',c.name));return profile(c.name);}}});
  const actor=await f.login(1),other=await f.login(3),key=randomUUID(),body=customer({name:'可信接口验收企业'});
  const created=await f.request('/customers',{actor,method:'POST',body,key});assert.equal(created.status,200);assert.equal(calls,1);assert.equal(one(f.db,'SELECT state FROM customer_profiles WHERE customer_id=?',created.body.id).state,'ready');
  assert.equal((await f.request('/customers',{actor,method:'POST',body,key})).status,200);assert.equal(calls,1);
  const shared=(await f.request('/state',{actor:other})).body.customers.find(c=>c.id===created.body.id);assert.equal(shared.shared,true);assert.equal(shared.company_profile,undefined);
  assert.equal((await f.request('/customers/'+created.body.id+'/company-profile/refresh',{actor:other,method:'POST',body:{}})).status,403);assert.equal(calls,1);
  const edit=await f.request('/customers/'+created.body.id,{actor,method:'PATCH',body:{name:'可信接口验收企业新名称'}});assert.equal(edit.status,200);
  const stale=(await f.request('/state',{actor})).body.customers.find(c=>c.id===created.body.id).company_profile;assert.equal(stale.state,'stale');assert.equal(stale.details.company_name,body.name);
});

test('企业接口失败不撤销客户，不把异常里的凭据或上游响应显示给页面',async t=>{
  const f=await fixture(t,{companyProfileProvider:{configured:true,provider:'隔离接口',lookup:async()=>{throw new Error('secret-fixture-token https://invalid/?token=secret');}}}),actor=await f.login(1);
  const result=await f.request('/customers',{actor,method:'POST',body:customer()});assert.equal(result.status,200);const stored=one(f.db,'SELECT * FROM customer_profiles WHERE customer_id=?',result.body.id);assert.equal(stored.state,'failed');assert.doesNotMatch(JSON.stringify(stored),/secret|token=/);assert(one(f.db,'SELECT id FROM customers WHERE id=?',result.body.id));
});

test('读取企业信息期间客户归属或主体变化时拒绝保存旧结果',async t=>{
  const entered=deferred(),done=deferred();let active=false;
  const f=await fixture(t,{companyProfileProvider:{configured:true,provider:'隔离接口',lookup:async c=>{if(active){entered.resolve();await done.promise;}return profile(c.name);}}}),actor=await f.login(1);
  const result=await f.request('/customers',{actor,method:'POST',body:customer()}),id=result.body.id;active=true;
  const request=f.request('/customers/'+id+'/company-profile/refresh',{actor,method:'POST',body:{}});await entered.promise;
  run(f.db,'UPDATE customers SET name=?,updated_at=? WHERE id=?','已修改主体','2026-11-02T00:00:00Z',id);done.resolve();
  assert.equal((await request).status,409);assert.equal(JSON.parse(one(f.db,'SELECT details FROM customer_profiles WHERE customer_id=?',id).details).company_name,customer().name);
});

test('阶段建议只在点击后运行，同一客户多商机分开，幂等且不写跟进或修改阶段',async t=>{
  const seen=[];const f=await fixture(t,{salesAdviceProvider:{configured:true,model:'qwen/qwen3.8-max',analyze:async input=>{seen.push(input);return advice();}}}),actor=await f.login(1);
  const {cid,oid}=await makeOpp(f,actor);const second=await f.request('/opportunities',{actor,method:'POST',body:opp(cid,{name:'另一条售卖产品 R2'})});assert.equal(second.status,200);
  run(f.db,"INSERT INTO activities(opportunity_id,user_id,source,activity_type,summary,action,activity_date,created_at) VALUES(?,1,'手动','手动跟进',?,'','2026-11-02','2026-11-02')",second.body.id,'第二商机独有资料不应混入第一商机');
  await f.request('/state',{actor});assert.equal(seen.length,0);
  const count=one(f.db,'SELECT count(*) n FROM activities').n,key=randomUUID();
  for(let i=0;i<2;i++){const result=await f.request('/opportunities/'+oid+'/ai-advice',{actor,method:'POST',body:{},key});assert.equal(result.status,200);assert.equal(result.body.opportunity_id,oid);assert.equal(result.body.customer_id,cid);assert.equal(result.body.advice.next_actions.length,3);}
  assert.equal(seen.length,1);assert.equal(seen[0].opportunity.sold_product,'已维护售卖产品 R1');assert.doesNotMatch(JSON.stringify(seen[0]),/第二商机独有|另一条售卖产品/);
  assert.equal(seen[0].customer.verified_company_profile,null);assert.equal(one(f.db,'SELECT count(*) n FROM activities').n,count);
  assert.equal((await f.request('/opportunities/'+second.body.id+'/ai-advice',{actor,method:'POST',body:{}})).status,200);assert.equal(seen[1].opportunity.sold_product,'另一条售卖产品 R2');
});

test('AI返回后对商机资料和可见跟进版本复核，变化不返回过期建议',async t=>{
  const entered=deferred(),done=deferred();const f=await fixture(t,{salesAdviceProvider:{configured:true,analyze:async()=>{entered.resolve();await done.promise;return advice();}}}),actor=await f.login(1);
  const {oid}=await makeOpp(f,actor);const pending=f.request('/opportunities/'+oid+'/ai-advice',{actor,method:'POST',body:{}});await entered.promise;
  run(f.db,"UPDATE opportunities SET stage='商务' WHERE id=?",oid);done.resolve();const response=await pending;assert.equal(response.status,409);assert.equal(response.body.advice,undefined);
});

test('AI返回后重新核对归属权限，缓存命中也不能绕过撤权',async t=>{
  const entered=deferred(),done=deferred();let wait=false,calls=0;
  const f=await fixture(t,{salesAdviceProvider:{configured:true,analyze:async()=>{calls++;if(wait){entered.resolve();await done.promise;}return advice();}}}),sales=await f.login(2);
  const {oid}=await makeOpp(f,sales),key=randomUUID(),path='/opportunities/'+oid+'/ai-advice';
  assert.equal((await f.request(path,{actor:sales,method:'POST',body:{},key})).status,200);
  run(f.db,'UPDATE opportunities SET owner_id=3 WHERE id=?',oid);assert.equal((await f.request(path,{actor:sales,method:'POST',body:{},key})).status,403);assert.equal(calls,1);
  run(f.db,'UPDATE opportunities SET owner_id=2 WHERE id=?',oid);wait=true;
  const pending=f.request(path,{actor:sales,method:'POST',body:{}});await entered.promise;run(f.db,'UPDATE opportunities SET owner_id=3 WHERE id=?',oid);done.resolve();assert.equal((await pending).status,403);
});

test('分析服务和企查查异常脱敏，结构不完整的模型结果不能伪装成功',async()=>{
  const ai=createSalesAdviceAI({env:{PPIO_API_KEY:'fixture-key'},fetcher:async()=>{throw new Error('Bearer fixture-secret');}});
  await assert.rejects(ai.analyze({}),e=>e.status===502&&!/fixture-secret/.test(e.message));
  const bad=createSalesAdviceAI({env:{PPIO_API_KEY:'fixture-key'},fetcher:async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"stage_assessment":"空建议"}'}}]}))});
  await assert.rejects(bad.analyze({}),e=>e.status===502);
  assert.match(SALES_ADVICE_SYSTEM,/15年以上/);assert.match(SALES_ADVICE_SYSTEM,/参保人数不等于/);
});

test('客户详细信息独立呈现状态和来源，外部字符串转义，共享主档不泄露',()=>{
  const c={id:7,company_profile:{state:'ready',provider:'可信接口',checked_at:'2026-11-02T01:00:00Z',details:{company_name:'<img src=x onerror=1>',business_scope:'<script>危险</script>',main_business:null}}};
  const html=companyProfileDetails(c,true);assert.match(html,/详细信息/);assert.doesNotMatch(html,/来源：|可信接口/);assert.match(html,/源接口未提供/);assert.doesNotMatch(html,/<script>|<img src=x/);assert.match(html,/refresh-company-profile/);assert.equal(companyProfileDetails({...c,shared:true},true),'');
});

test('AI接收预览不会查询企业，确认新建后同请求读取一次，重复确认不再外发',async t=>{
  let calls=0;
  const f=await fixture(t,{companyProfileProvider:{configured:true,provider:'隔离企业接口',lookup:async c=>{calls++;return profile(c.name);}},aiProvider:{configured:true,model:'qwen/qwen3.8-max',prepare:async()=>({model:'qwen/qwen3.8-max',summary:'隔离新客户',questions:[],usage:{},operations:[{type:'customer',action:'create',ref:'new_customer',source_file:'粘贴内容',data:customer({name:'AI确认后才查询的企业'}),evidence:'用户提供企业名称与负责人'}]})}}),actor=await f.login(1);
  const draft=await f.request('/ai/intake',{actor,method:'POST',body:{text:'录入隔离的新客户资料'}});assert.equal(draft.status,200);assert.equal(draft.body.valid,true,JSON.stringify(draft.body));assert.equal(calls,0);assert.equal(one(f.db,'SELECT count(*) n FROM customer_profiles').n,0);
  const batch=(await f.request('/ai/batches/'+draft.body.id,{actor})).body,key=randomUUID(),body={version:batch.version,acknowledged:true};
  const confirmed=await f.request('/ai/batches/'+batch.id+'/confirm',{actor,method:'POST',body,key});assert.equal(confirmed.status,200);assert.equal(calls,1);assert.equal(one(f.db,'SELECT state FROM customer_profiles WHERE customer_id=?',confirmed.body.result[0].id).state,'ready');
  assert.equal((await f.request('/ai/batches/'+batch.id+'/confirm',{actor,method:'POST',body,key})).status,200);assert.equal(calls,1);
});

test('企业详情后续读取失败保留上次来源资料，AI不把失败快照当当前已核实事实',async t=>{
  let fail=false,captured;
  const f=await fixture(t,{companyProfileProvider:{configured:true,provider:'隔离企业接口',lookup:async c=>{if(fail)throw new Error('上游超时');return profile(c.name);}},salesAdviceProvider:{configured:true,model:'qwen/qwen3.8-max',analyze:async c=>{captured=c;return advice();}}}),actor=await f.login(1);
  const {cid,oid}=await makeOpp(f,actor);fail=true;
  const refresh=await f.request('/customers/'+cid+'/company-profile/refresh',{actor,method:'POST',body:{}});assert.equal(refresh.status,200);assert.equal(refresh.body.company_profile.state,'failed');assert.equal(refresh.body.company_profile.provider,'隔离企业接口');assert.equal(refresh.body.company_profile.details.employee_scale,'100–199人');assert.match(refresh.body.company_profile.reason,/保留上次/);
  assert.equal((await f.request('/opportunities/'+oid+'/ai-advice',{actor,method:'POST',body:{}})).status,200);assert.equal(captured.customer.verified_company_profile,null);assert.equal(captured.customer.profile_state,'failed');
});

test('管理员AI确认合同附件后自动识别一次，预览及重复回执不识别，合同金额和付款不被提案写入',async t=>{
  let calls=0,f;
  const ai={configured:true,model:'qwen/qwen3.8-max',prepare:async()=>({model:'qwen/qwen3.8-max',summary:'保存隔离合同原件',questions:[],usage:{},operations:[{type:'contract_attachment',action:'create',ref:'attachment1',source_file:'核对合同.txt',data:{contract_id:1,source_file:'核对合同.txt'},evidence:'明确保存当前合同原件'}]}),extractContract:async file=>{
    calls++;assert.equal(f.db.isTransaction,false);assert.equal(file.name,'核对合同.txt');
    return {model:'qwen/qwen3.8-max',result:{total_amount:880000,payment_stages:[{name:'首款',amount:880000,due_date:null,condition:'签约后支付',evidence:'首款人民币8800元'}],summary:'独立识别结果',questions:[]}};
  }};
  f=await fixture(t,{aiProvider:ai});const actor=await f.login(1),before=one(f.db,'SELECT amount FROM contracts WHERE id=1').amount,payments=one(f.db,'SELECT count(*) n FROM payments').n;
  const draft=await f.request('/ai/intake',{actor,method:'POST',body:{text:'保存当前合同附件',files:[{name:'核对合同.txt',base64:Buffer.from('总金额8800元；签约后支付首款8800元').toString('base64')}]}});assert.equal(draft.status,200);assert.equal(draft.body.valid,true);assert.equal(calls,0);
  const batch=(await f.request('/ai/batches/'+draft.body.id,{actor})).body,key=randomUUID(),body={version:batch.version,acknowledged:true};
  const first=await f.request('/ai/batches/'+batch.id+'/confirm',{actor,method:'POST',body,key});assert.equal(first.status,200);assert.equal(calls,1);
  const repeated=await f.request('/ai/batches/'+batch.id+'/confirm',{actor,method:'POST',body,key});assert.equal(repeated.status,200);assert.deepEqual(repeated.body,first.body);assert.equal(calls,1);
  const contract=(await f.request('/state',{actor})).body.contracts.find(c=>c.id===1);assert.equal(contract.contract_analysis.state,'ready');assert.equal(contract.contract_analysis.result.total_amount,880000);assert.equal(one(f.db,'SELECT amount FROM contracts WHERE id=1').amount,before);assert.equal(one(f.db,'SELECT count(*) n FROM payments').n,payments);
});
