import test from 'node:test';
import assert from 'node:assert/strict';
import {opportunities,opportunityGroups,opportunityListTable,opportunityServiceAmount} from '../public/modules/opportunities.js';
import {filters,oppTable} from '../public/modules/shared.js';

const stages=['线索','需求','方案','商务','赢单','输单','搁置'];
const state=(rows=[])=>({
  actor:{id:1,name:'管理员',role:'admin'},today:'2026-11-02',stages,
  users:[{id:1,name:'管理员',role:'admin',active:1},{id:2,name:'销售甲',role:'sales',active:1},{id:3,name:'销售乙',role:'sales',active:1},{id:4,name:'同名销售',role:'sales',active:0},{id:5,name:'同名销售',role:'sales',active:1}],
  customers:[{id:10,name:'客户全称有限公司',short_name:'客户简称',manual_level:'A'},{id:11,name:'第二客户',manual_level:'B'}],
  rules:{customer_levels:['A','B','C']},opportunities:rows,
});
const opportunity=(id,extra={})=>({id,customer_id:10,owner_id:2,name:`产品${id}`,code:`OP-${id}`,stage:'需求',amount:100000,product_amount:30000,order_type:'千帆',sale_type:'新签自建',created_at:'2026-11-01T00:00:00Z',next_action:'详情保留的下一步',follow_date:'2026-11-02',risk:{level:'normal',overdue:0,label:'正常推进'},...extra});
const rowIds=html=>[...html.matchAll(/<tr[^>]+data-action="opportunity" data-id="([^"]+)"/g)].map(match=>Number(match[1]));
const clean=html=>html.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();

test('商机总表按销售分组并固定阶段顺序，同客户多商机及未知旧阶段全部保留',()=>{
  const order=['赢单','商务','方案','需求','线索','输单','搁置','旧阶段',''];
  const rows=order.map((stage,index)=>opportunity(index+1,{stage,name:'同一个售卖产品'})).reverse();
  rows.splice(3,0,opportunity(20,{owner_id:3,stage:'赢单'}));
  const original=structuredClone(rows),S=state(rows),groups=opportunityGroups(S,rows);
  assert.equal(groups.length,2);
  assert.deepEqual(groups.find(group=>group.owner_id==='2').rows.map(row=>row.id),[1,2,3,4,5,6,7,8,9]);
  assert.equal(groups.flatMap(group=>group.rows).length,10);
  assert.deepEqual(rows,original,'分组排序不能改写输入状态或历史阶段');
  const html=opportunities(S,{owner:'3'});
  assert.equal(rowIds(html).length,10,'已撤销的负责人筛选不能隐藏其他销售');
  assert.equal(new Set(rowIds(html)).size,10);
  assert.match(html,/共 10 条商机 · 按销售小二分组/);
  assert.match(html,/客户全称有限公司/);
  assert.doesNotMatch(html,/全部负责人|id="filter-owner"/);
});

test('分组使用负责人ID，同名、停用、未分配及未知负责人均不丢记录',()=>{
  const rows=[opportunity(1,{owner_id:4}),opportunity(2,{owner_id:5}),opportunity(3,{owner_id:null}),opportunity(4,{owner_id:99})];
  const groups=opportunityGroups(state(rows),rows);
  assert.equal(groups.length,4);
  assert.equal(groups.filter(group=>group.name==='同名销售').length,2);
  assert.deepEqual(groups.flatMap(group=>group.rows).map(row=>row.id).sort(),[1,2,3,4]);
  assert.equal(groups.find(group=>group.owner_id===null).name,'未分配销售小二');
  assert.equal(groups.find(group=>group.owner_id==='99').name,'未识别销售（编号 99）');
});

test('每组阶段优先，金额和创建时间仅在同阶段内排序，空值始终居后且同值次序稳定',()=>{
  const rows=[opportunity(5,{amount:null,created_at:null}),opportunity(3,{amount:100,created_at:'2026-10-01'}),opportunity(2,{amount:100,created_at:'2026-10-01'}),opportunity(4,{amount:900,created_at:'2026-11-01'}),opportunity(1,{stage:'赢单',amount:1,created_at:'2026-01-01'})];
  const S=state(rows),ids=P=>opportunityGroups(S,rows,P)[0].rows.map(row=>row.id);
  assert.deepEqual(ids({}),[1,4,2,3,5]);
  assert.deepEqual(ids({sort:'follow_date',desc:false}),[1,4,2,3,5],'旧页面排序不能改变新默认');
  assert.deepEqual(ids({sort:'amount',desc:false}),[1,2,3,4,5]);
  assert.deepEqual(ids({sort:'amount',desc:true}),[1,4,2,3,5]);
  assert.deepEqual(ids({sort:'created_at',desc:false}),[1,2,3,4,5]);
  assert.deepEqual(opportunityGroups(S,[...rows].reverse(),{sort:'amount',desc:false})[0].rows.map(row=>row.id),[1,2,3,4,5]);
});

test('项目服务金额只在总额和cash都已知时计算，明确零有效，历史缺失不猜成零',()=>{
  assert.equal(opportunityServiceAmount({amount:123456,product_amount:23456}),100000);
  assert.equal(opportunityServiceAmount({amount:0,product_amount:0}),0);
  assert.equal(opportunityServiceAmount({amount:123456,product_amount:0}),123456);
  for(const amount of [null,undefined,'',NaN])assert.equal(opportunityServiceAmount({amount,product_amount:0}),null);
  for(const product_amount of [null,undefined,'',NaN])assert.equal(opportunityServiceAmount({amount:123456,product_amount}),null);
  const rows=[opportunity(1,{amount:123456,product_amount:23456}),opportunity(2,{amount:0,product_amount:0}),opportunity(3,{amount:null,product_amount:null,created_at:null})];
  const html=opportunityListTable(state(rows),rows),body=[...html.matchAll(/<tr class="record-row"[^>]*>(.*?)<\/tr>/gs)].map(match=>clean(match[1]));
  assert.ok(body.some(text=>text.includes('¥1,234.56 ¥234.56 ¥1,000')));
  assert.ok(body.some(text=>text.includes('¥0 ¥0 ¥0')));
  assert.ok(body.some(text=>text.includes('未提供 未提供 未提供')));
  assert.doesNotMatch(html,/NaN|undefined/);
});

test('总表展示九项要求字段并保留详情入口，跟进和推进信息仍只在其他表格显示',()=>{
  const rows=[opportunity(1)],S=state(rows),html=opportunities(S,{});
  const head=html.match(/<thead>(.*?)<\/thead>/s)[1];
  assert.equal((head.match(/<th /g)||[]).length,9);
  for(const label of ['客户名称','售卖产品','商机阶段','合同金额','cash金额','项目 / 服务金额','销售小二','订单类型','创建时间'])assert.ok(clean(head).includes(label),label);
  assert.doesNotMatch(html,/下一步|跟进时间|推进状态|stage-track/);
  assert.match(html,/2026\/11\/01 08:00:00/,'UTC创建时间按北京时间显示');
  assert.match(html,/data-action="opportunity" data-id="1"/);
  assert.match(html,/class="table-scroll opportunity-list-scroll" tabindex="0" role="region"/);
  assert.match(html,/href="\.\/modules\/opportunities\.css"/);
  assert.match(opportunityListTable(S,rows,{sort:'amount',desc:true}),/aria-sort="descending"><button data-action="sort" data-id="amount"/);
  const compact=oppTable(S,rows,true),team=oppTable(S,rows);
  for(const other of [compact,team]){assert.match(other,/下一步 \/ 跟进时间/);assert.match(other,/推进状态/);}
  for(const kind of ['customers','contracts'])assert.match(filters(S,{},kind),/id="filter-owner"/);
});

test('销售只渲染已授权状态中的商机，空数据和查询无结果保持可用',()=>{
  const rows=[opportunity(1)],S={...state(rows),actor:{id:2,name:'销售甲',role:'sales'}};
  const html=opportunities(S,{owner:'3'});
  assert.deepEqual(rowIds(html),[1]);
  assert.doesNotMatch(html,/销售乙|全部负责人|id="filter-owner"/);
  for(const result of [opportunities({...S,opportunities:[]},{}),opportunities(S,{q:'没有这个产品'})]) {
    assert.match(result,/没有匹配的商机/);
    assert.match(result,/共 0 条商机/);
    assert.doesNotMatch(result,/data-action="opportunity"|NaN|undefined/);
  }
});

test('搜索、阶段与看板日期类型筛选继续生效且不按客户去重',()=>{
  const rows=[opportunity(1,{name:'同名产品'}),opportunity(2,{name:'同名产品',owner_id:3}),opportunity(3,{stage:'商务'}),opportunity(4,{created_at:'2026-09-01'}),opportunity(5,{sale_type:'续费'}),opportunity(6,{customer_id:11})],S=state(rows);
  const html=opportunities(S,{owner:'2',q:'同名产品',stage:'需求',customerLevel:'A',saleType:'新签自建',from:'2026-11-01',to:'2026-11-02'});
  assert.deepEqual(rowIds(html),[1,2]);
  assert.match(html,/沿用看板筛选/);
  assert.match(html,/全部商机 <b>2<\/b>/);
});

test('产品、销售、客户和旧阶段中的HTML只显示文本',()=>{
  const row=opportunity(1,{name:'<img src=x>',stage:'<script>bad()</script>',order_type:'<b>类型</b>'}),S=state([row]);
  S.users.find(user=>user.id===2).name='<i>销售</i>';S.customers[0].name='<strong>客户</strong>';
  const html=opportunities(S,{});
  assert.doesNotMatch(html,/<img src=x>|<script>bad|<i>销售|<strong>客户|<b>类型/);
  for(const text of ['&lt;img src=x&gt;','&lt;script&gt;bad()&lt;/script&gt;','&lt;i&gt;销售&lt;/i&gt;','&lt;strong&gt;客户&lt;/strong&gt;'])assert.ok(html.includes(text));
});
