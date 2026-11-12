import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboard,dashboardScope} from '../public/modules/dashboards.js';
import {workbench} from '../public/modules/workbench.js';
import {filtered,followupFilters,needsFollowup,reportMonthForPage} from '../public/modules/shared.js';
import {opportunities} from '../public/modules/opportunities.js';
import {commissions} from '../public/modules/incentives.js';
import {formContent,pages} from '../public/views.js';
import {fixture} from './helpers/fixture.mjs';
import {today,now} from '../server/domain.mjs';
import {run,one} from '../server/database.mjs';

const clean=value=>value.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
function metrics(html) {
  return Object.fromEntries([...html.matchAll(/class="(?:management-)?metric-label"[^>]*>(.*?)<\/(?:span|div)>\s*<(?:strong|div|span) class="(?:management-)?metric-value"[^>]*>(.*?)<\/(?:strong|div|span)>/gs)].map(match=>[clean(match[1]),clean(match[2])]));
}
function state() {
  return {actor:{id:1,name:'管理员',role:'admin'},today:'2026-11-01',period:'2026-11',users:[{id:1,name:'管理员',role:'admin',active:1},{id:2,name:'销售甲',role:'sales',active:1}],stages:['线索','需求','方案','商务','赢单','输单','搁置'],customers:[{id:10,name:'甲客户',owner_id:2,manual_level:'A'}],opportunities:[],contracts:[],contacts:[],quotes:[],activities:[],activityEvents:[],team:[],rules:{commission:{threshold:20000000,low_rate:.03,high_rate:.05}}};
}
const contract=(id,date,amount,payments,extra={})=>({id,customer_id:10,owner_id:2,lifecycle:'历史登记',sign_date:date,amount,payments,...extra});
const payment=(date,amount,status='已到账')=>({pay_date:date,amount,status});
const opportunity=(id,followDate,risk='warning',extra={})=>({id,customer_id:10,owner_id:2,name:`商机${id}`,stage:'需求',amount:10000,product_amount:10000,created_at:'2026-10-15',follow_date:followDate,risk:{level:risk,overdue:0,days:30,label:'待跟进'},next_action:'联系客户',sale_type:'新签自建',...extra});

test('经营分析历史区间按签约与到账各自日期统计，包含更早合同在区间内到账',()=>{
  const S=state();
  S.contracts=[contract(1,'2026-10-15',123400,[payment('2026-10-20',11100)]),contract(2,'2026-09-15',900000,[payment('2026-10-05',678900),payment('2026-11-01',33300)]),contract(3,'2026-10-02',80000,[payment('2026-10-20',80000)],{lifecycle:'草稿'}),contract(4,'2026-10-02',70000,[payment('2026-10-20',70000)],{owner_id:3})];
  const P={view:'analytics',owner:'2',from:'2026-10-01',to:'2026-10-31'};
  const html=dashboard(S,P),values=metrics(html);
  assert.match(html,/签约额 ¥1,234/);
  assert.equal(values['区间实际到账'],'¥6,900');
  assert.match(html,/2026-10-01 至 2026-10-31/);
  assert.doesNotMatch(html,/本月实际到账/);
  assert.deepEqual(metrics(dashboard({...S,period:'2025-01'},P)),values);
});

test('工作台本月固定当前自然月，不继承绩效历史月份；分析支持单边范围与无效日期提示',()=>{
  const S={...state(),period:'2026-10',contracts:[contract(1,'2026-10-15',123400,[payment('2026-10-20',11100)]),contract(2,'2026-11-01',20000,[payment('2026-11-01',25000)])]};
  const values=metrics(workbench(S));
  assert.equal(values['本月新签合同'],'¥200');assert.equal(values['本月实际到账'],'¥250');
  assert.equal(metrics(dashboard(S,{view:'personal',owner:'2'}))['实际到账'],'¥250');
  assert.match(dashboard(S,{view:'analytics',to:'2026-10-31'}),/签约额 ¥1,234/);
  const invalid=dashboard(S,{view:'analytics',from:'2026-11-01',to:'2026-10-01'});
  assert.match(invalid,/起始日期不能晚于结束日期/);assert.doesNotMatch(invalid,/data-id="receipts"/);
});

test('仅绩效页面保留已选历史月，工作台、团队、导出所用页面均请求自然月',()=>{
  for(const page of Object.keys(pages))assert.equal(reportMonthForPage(page,'2026-08','2026-11-01'),page==='performance'?'2026-08':'2026-11');
  assert.equal(reportMonthForPage('performance','','2026-11-01'),'2026-11');
  assert.equal(reportMonthForPage('performance','2026-08','2026-11-01'),'2026-08');
});

test('今日行动与全部待跟进共用集合，保留未填或未来跟进日的风险，排除关闭商机',()=>{
  const S=state();S.opportunities=[opportunity(1,'2026-11-05'),opportunity(2,'','critical'),opportunity(3,'2026-10-31','normal'),opportunity(4,'2026-10-31','warning',{stage:'赢单'}),opportunity(5,'2026-11-05','normal')];
  const visible=filtered(S,followupFilters(S,{view:'workbench'}),S.opportunities);
  assert.deepEqual(visible.map(row=>row.id),[1,2,3]);
  assert.equal(metrics(workbench(S))['待处理事项'],'3 项');
  const html=opportunities(S,followupFilters(S,{view:'workbench'}));
  assert.match(html,/共 3 条商机/);
  for(const id of [1,2,3])assert.match(html,new RegExp(`data-opportunity-id="${id}"`));
});

test('从个人或经营看板查看全部待办保留销售、客户等级、类型与创建日期范围',()=>{
  const S=state();S.customers.push({id:11,name:'乙客户',owner_id:2,manual_level:'B'});
  S.opportunities=[opportunity(1,'2026-11-05'),opportunity(2,'','critical'),opportunity(3,'','warning',{owner_id:3}),opportunity(4,'','warning',{created_at:'2026-09-30'}),opportunity(5,'','warning',{sale_type:'续费'}),opportunity(6,'','warning',{customer_id:11})];
  const P={view:'analytics',owner:'2',level:'A',manual_level:'A',saleType:'新签自建',from:'2026-10-01',to:'2026-10-31'};
  const cardRows=dashboardScope(S,P).opportunities.filter(row=>needsFollowup(row,S.today));
  const navigation=followupFilters(S,P),listRows=filtered(S,navigation,S.opportunities);
  assert.deepEqual(listRows.map(row=>row.id),[1,2]);assert.deepEqual(listRows,cardRows);
  assert.match(opportunities(S,navigation),/沿用看板筛选/);
  assert.equal(followupFilters(S,{view:'personal'}).owner,'1');
});

test('提成历史批次只读，旧表单和发放HTTP入口均不能写入',async t=>{
 const f=await fixture(t),admin=await f.login(1),sales=await f.login(2);
 const id=Number(run(f.db,"INSERT INTO commission_batches(sales_id,kind,period,base,rate,amount,status,snapshot,created_at,confirmed_by) VALUES(2,'personal','2026Q4',10000,0.1,1000,'confirmed','{}',?,1)",now()).lastInsertRowid);
 const original=one(f.db,'SELECT * FROM commission_batches WHERE id=?',id);
 const S=(await f.request('/state?commissionPeriod=2026Q4',{actor:admin})).body;
 assert.doesNotMatch(commissions(S,{}),/data-action="commission-pay"/);
 assert.doesNotMatch(formContent(S,'commission-pay',id),/data-form="commission-pay"/);
 assert.equal((await f.request(`/commissions/${id}/pay`,{actor:sales,method:'POST',body:{paid_at:today()}})).status,403);
 assert.equal((await f.request(`/commissions/${id}/pay`,{actor:admin,method:'POST',body:{paid_at:today()}})).status,410);
 assert.deepEqual(one(f.db,'SELECT * FROM commission_batches WHERE id=?',id),original);
});
