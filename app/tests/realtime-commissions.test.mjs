import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/fixture.mjs';
import {historicalCommission} from './helpers/historical-commission.mjs';
import {all,one,run} from '../server/database.mjs';
import {commissionPreview} from '../server/modules/incentives.mjs';
import {commissionTier} from '../server/modules/commission-diagnostics.mjs';
import {selectCommissionRows,selectCommissionHistory,commissionIssueRows,buildCommissionExport} from '../public/modules/commission-view-model.js';
import {shiftCommissionPeriod,currentCommissionPeriod} from '../public/modules/commission-period.js';
import {commissions,formIncentives} from '../public/modules/incentives.js';
import {intakeSchema} from '../public/modules/intake-schema.js';

async function setup(t){
 t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,11,15,3)});
 const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
 const rules=()=>JSON.parse(one(f.db,"SELECT value FROM settings WHERE key='rules'").value);
 const model=(month='2026-11')=>commissionPreview(f.db,rules(),one(f.db,'SELECT * FROM users WHERE id=1'),month);
 const personal=()=>model().realtime_previews.find(p=>p.sales_id===2&&p.kind==='personal');
 async function create(items,owner_id=2){const r=await f.request('/contracts',{actor:admin,method:'POST',body:{customer_id:1,owner_id,name:'实时计算验收合同',sign_date:'2026-10-01',items}});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id;}
 async function pay(id,amount,product_amount){const r=await f.request('/payments',{actor:admin,method:'POST',body:{contract_id:id,amount,status:'已到账',pay_date:'2026-11-10',...(product_amount!==undefined?{product_amount}:{})}});assert.equal(r.status,200,JSON.stringify(r.body));return r.body.id;}
 async function grade(){assert.equal((await f.request('/performance/review',{actor:admin,method:'POST',body:{user_id:2,month:'2026-11',final_score:80,reason:'隔离验收',status:'draft'}})).status,200);}
 return {...f,admin,sales,rules,model,personal,create,pay,grade};
}
const product=(amount,margin)=>({name:'产品授权',kind:'标品',amount,...(margin!==undefined?{margin}:{})});
const service=amount=>({name:'开发服务',kind:'定开',amount,margin:amount/2});
test('实时产品仍按实际到账毛利选档，草稿绩效即可计算且不新增确认锁',async t=>{
 const f=await setup(t),id=await f.create([product(100000,25000)]);await f.pay(id,100000);await f.grade();
 const before=all(f.db,'SELECT * FROM commission_batches'),p=f.personal();assert.equal(p.scheme,'sales-receipt-margin-v2');assert.equal(p.components[0].base,2500000);assert.equal(p.total,250000);assert.equal(p.estimated_total,250000);assert.equal(p.calculated_total,250000);assert.equal(p.lines[0].amount,p.lines[0].entitlement);assert.equal(p.product_tier.distance_to_next,1500000);
 const state=(await f.request('/state?commissionPeriod=2026-11',{actor:f.admin})).body;assert.doesNotMatch(commissions(state,{}),/服务签约额|服务签约金额|按产品实际回款计算/);
 assert.equal(f.model().realtime,true);assert.equal(f.model().live_pay_enabled,false);assert.deepEqual(all(f.db,'SELECT * FROM commission_batches'),before);
});
test('未回款服务不计提，已回款服务独立于未知产品计算',async t=>{
 const f=await setup(t),a=await f.create([service(30000)]),b=await f.create([product(100000)]);await f.create([service(50000)]);await f.pay(a,30000);await f.pay(b,100000);await f.grade();
 const p=f.personal();assert.equal(p.components[0].total,null);assert.equal(p.components[1].base,3000000);assert.equal(p.components[1].total,240000);assert.equal(p.estimated_total,240000);assert.equal(p.calculated_total,240000);assert.equal(p.partial,true);assert.ok(p.lines.some(l=>l.component==='product'&&l.amount===null));
});
test('全未知保留NULL，明确零毛利保留0',async t=>{
 const f=await setup(t),id=await f.create([product(100000)]);await f.pay(id,100000);await f.grade();assert.equal(f.personal().estimated_total,null);
 run(f.db,'UPDATE contract_items SET margin=0,margin_before_expense=0 WHERE contract_id=?',id);assert.equal(f.personal().estimated_total,0);
});
test('混合回款未分配使产品档位暂算，但正常服务仍为明确金额',async t=>{
 const f=await setup(t),a=await f.create([product(100000,25000)]),b=await f.create([product(50000,25000),service(50000)]),c=await f.create([service(30000)]);await f.pay(a,100000);await f.pay(b,10000);await f.pay(c,30000);await f.grade();
 const p=f.personal();assert.equal(p.product_tier.status,'basis-incomplete');assert.equal(p.product_tier.distance_to_next,null);assert.equal(p.components[1].total,240000);assert.ok(p.estimated_total>=240000);assert.ok(p.contract_issues.some(i=>i.code==='receipt_split_missing'));
});
test('历史确认和发放只读保留，当前应计不扣历史',async t=>{
 const f=await setup(t),id=await f.create([product(100000,25000)]);await f.pay(id,100000);await f.grade();const preview=f.model().previews.find(p=>p.sales_id===2);const h=historicalCommission(f,preview,{paid:true});
 const before=one(f.db,'SELECT * FROM commission_batches WHERE id=?',h.body.id);const lines=all(f.db,'SELECT * FROM commission_lines');
 assert.equal(f.personal().total,250000);assert.equal(f.personal().lines.reduce((s,l)=>s+l.amount,0),250000);
 for(const path of ['/commissions/confirm',`/commissions/${h.body.id}/pay`,'/commissions/disbursements']){
  assert.equal((await f.request(path,{actor:f.admin,method:'POST',body:preview})).status,410);
  assert.equal((await f.request(path,{actor:f.sales,method:'POST',body:preview})).status,403);
 }
 assert.deepEqual(one(f.db,'SELECT * FROM commission_batches WHERE id=?',h.body.id),before);assert.deepEqual(all(f.db,'SELECT * FROM commission_lines'),lines);
});
test('旧算法合同排除可解释，不改写原批次且正常合同继续计算',async t=>{
 const f=await setup(t),a=await f.create([product(100000,25000)]),b=await f.create([service(30000)]);await f.pay(a,100000);await f.pay(b,30000);await f.grade();
 const p=f.model().previews.find(p=>p.sales_id===2);const snap={...p,scheme:'legacy',lines:p.lines.filter(l=>l.contract_id===a).map(l=>({...l,component:'legacy'}))};historicalCommission(f,snap);
 assert.equal(f.personal().excluded_contracts[0].contract_id,a);assert.equal(f.personal().components[1].total,240000);
});
test('停用成员有当期来源仍可读，无写入恢复启用状态',async t=>{
 const f=await setup(t),id=await f.create([product(100000,25000)]);await f.pay(id,100000);await f.grade();run(f.db,'UPDATE users SET active=0 WHERE id=2');const p=f.personal();assert.equal(p.active,false);assert.equal(p.total,250000);assert.equal(one(f.db,'SELECT active FROM users WHERE id=2').active,0);
});
test('管理者个人按销售月份，团队管理保留累计周期，开发者和PM不进入计提',async t=>{
 const f=await setup(t),rows=f.model().realtime_previews;assert.equal(rows.find(p=>p.sales_id===1&&p.kind==='personal').period,'2026-11');assert.equal(rows.find(p=>p.sales_id===1&&p.kind==='management').period,'2026Q4');assert.ok(rows.filter(p=>p.sales_id===2).every(p=>p.period==='2026-11'));assert.ok(rows.every(p=>['admin','sales'].includes(one(f.db,'SELECT role FROM users WHERE id=?',p.sales_id).role)));
 const s=(await f.request('/state?commissionPeriod=2026-11',{actor:f.sales})).body;assert.ok(selectCommissionRows(s,{owner:'1'}).every(p=>p.sales_id===2));
});
test('销售新增数据刷新不修改规则及历史，真实库结构版本保持35',async t=>{
 const f=await setup(t),before=one(f.db,"SELECT value FROM settings WHERE key='rules'").value;f.model();f.model();assert.equal(one(f.db,"SELECT value FROM settings WHERE key='rules'").value,before);assert.equal(one(f.db,'SELECT max(version) n FROM schema_version').n,35);
});
const model=()=>({actor:{id:1,role:'admin',name:'管理'},today:'2026-11-10',rules:{commission:{period:'quarter'}},users:[{id:1,role:'admin'},{id:2,role:'sales',name:'甲'},{id:3,role:'sales',name:'乙'}],contracts:[{id:10,name:'产品合同',contract_no:'HT-10',owner_id:2}],commission:{period:'2026-11',legacy_mode:'quarter',realtime_previews:[{sales_id:2,name:'甲',kind:'personal',period:'2026-11',estimated_total:10000,calculated_total:10000,lines:[{contract_id:10,contract_name:'产品合同',base:100000,rate:.1,entitlement:10000,amount:5,component:'product'}],contract_issues:[]},{sales_id:3,name:'乙',kind:'personal',period:'2026-11',estimated_total:null,calculated_total:null,lines:[],contract_issues:[{code:'rate_missing',message:'比例待核实',pending:true}]},{sales_id:1,name:'管理',kind:'management',period:'2026Q4',estimated_total:20000,lines:[]}],batches:[{id:1,sales_id:2,kind:'personal',period:'2026Q4',snapshot:{},amount:3000}]}});
test('搜索合同定位完整人员金额，状态及导出共享筛选',()=>{const S=model(),P={commissionQ:'HT-10'};assert.equal(selectCommissionRows(S,P)[0].estimated_total,10000);assert.equal(buildCommissionExport(S,P).detailRows[1][9],100);assert.equal(buildCommissionExport(S,{commissionStatus:'pending'}).summaryRows.length,2);assert.equal(selectCommissionRows(S,{commissionQ:'不存在'}).length,0);});
test('销售忽略隐藏owner筛选且导出不能串看他人，PM无范围',()=>{const S=model();S.actor={id:2,role:'sales',name:'甲'};assert.equal(selectCommissionRows(S,{owner:'3'}).length,1);assert.equal(buildCommissionExport(S,{owner:'3'}).summaryRows.length,2);S.actor.role='pm';assert.equal(selectCommissionRows(S).length,0);});
test('历史按独立真实周期过滤，不受实时待完善状态影响',()=>{const S=model();assert.equal(selectCommissionHistory(S,{commissionHistoryPeriod:'2026Q4',commissionStatus:'pending'}).length,1);assert.equal(selectCommissionHistory(S,{commissionHistoryPeriod:'2026-11'}).length,0);});
test('未知CSV金额留空，明确0保留，明细使用当前应计而非历史差额',()=>{const S=model();let e=buildCommissionExport(S,{owner:'3'});assert.equal(e.summaryRows[1][3],'');S.commission.realtime_previews[1].estimated_total=0;assert.equal(buildCommissionExport(S,{owner:'3'}).summaryRows[1][3],0);assert.equal(buildCommissionExport(S,{owner:'2'}).detailRows[1][9],100);});
test('普通信息不冒充待办，规则事项归管理员并保留来源合同',()=>{const S=model(),row=S.commission.realtime_previews[0];row.notices=[{code:'inactive_member',message:'停用仍可查询',pending:false}];assert.equal(commissionIssueRows(S,{owner:'2'}).length,0);row.contract_issues=[{contract_id:10,contract_name:'产品合同',code:'rate_missing',message:'比例待核实',pending:true}];assert.equal(commissionIssueRows(S,{owner:'2'})[0].responsibility,'admin');});
for(const [value,direction,expected] of [['2026-12',1,'2027-01'],['2026-01',-1,'2025-12'],['2026Q4',1,'2027Q1'],['2026Q1',-1,'2025Q4'],['2026',1,'2027']])test(`周期导航${value}/${direction}保持类型并正确跨年`,()=>assert.equal(shiftCommissionPeriod(value,direction),expected));
test('本期定位保持季度和年度类型',()=>{assert.equal(currentCommissionPeriod('2020Q1','2026-11-10'),'2026Q4');assert.equal(currentCommissionPeriod('2020','2026-11-10'),'2026');});
test('档位缺基数等级比例不承诺下一档，下一档空比例不称最高档',()=>{const bands=[{min:0,rates:{B:.1}},{min:4000000,rates:{B:null}}];let t=commissionTier(bands,2000000,{grade:'B'});assert.equal(t.next_rate_pending,true);assert.equal(t.at_maximum,false);assert.equal(t.distance_to_next,null);assert.equal(commissionTier(bands,2000000,{grade:'B',basisComplete:false}).status,'basis-incomplete');});
test('档位整额计提的下一档距离可解释',()=>{const t=commissionTier([{min:0,rates:{B:0}},{min:2000000,rates:{B:.1}},{min:4000000,rates:{B:.12}}],2000000,{grade:'B'});assert.equal(t.distance_to_next,2000000);assert.equal(t.next_rate,.12);assert.equal(t.whole_base,true);});
test('AI固定schema不再声明提成写类型',()=>{assert.equal(intakeSchema.commission_confirm,undefined);assert.equal(intakeSchema.commission_pay,undefined);});
