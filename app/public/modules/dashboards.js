import { esc, plainMoney, badge, sectionHead, actionButton as button,isClosedStage,isWonStage,isLostStage } from '../ui.js';
import { metrics, sum, oppTable, ownerOptions,pipeline } from './shared.js';
import { performance } from './incentives.js';
import { workbench } from './workbench.js';
const inRange=(d,P)=>d&&(!P.from||d.slice(0,10)>=P.from)&&(!P.to||d.slice(0,10)<=P.to);
const contractSaleType=(S,contract)=>contract.sale_type??S.opportunities.find(opportunity=>opportunity.id===contract.opportunity_id)?.sale_type;
export function dashboardScope(S,P) {
  const owner=P.owner||(P.view==='personal'?String(S.actor.id):'');
  const own=r=>!owner||r.owner_id===Number(owner);
  const ownsCustomer=c=>own(c)||(c.owner_id===null&&c.collaborators?.includes(Number(owner)));
  const customerIds=new Set(S.customers.filter(c=>!P.level||c.manual_level===P.level).map(c=>c.id));
  const opportunities=S.opportunities.filter(o=>own(o)&&customerIds.has(o.customer_id)&&(!P.saleType||o.sale_type===P.saleType)&&(!P.from&&!P.to||inRange(o.created_at,P)));
  const paymentContracts=S.contracts.filter(c=>c.lifecycle!=='草稿'&&(!P.saleType||contractSaleType(S,c)===P.saleType)&&own(c)&&customerIds.has(c.customer_id));
  const contracts=paymentContracts.filter(c=>!P.from&&!P.to||inRange(c.sign_date,P));
  const opportunityIds=new Set(opportunities.map(o=>o.id));
  const inActivityScope=a=>opportunityIds.has(a.opportunity_id)&&(!P.from&&!P.to||inRange(a.activity_date,P));
  return {...S,customers:S.customers.filter(c=>ownsCustomer(c)&&customerIds.has(c.id)),opportunities,contracts,paymentContracts,activities:S.activities.filter(inActivityScope),activityEvents:(S.activityEvents||[]).filter(inActivityScope),team:S.team.filter(u=>!owner||u.id===Number(owner))};
}
const controls=(S,P)=>`<div class="filterbar dashboard-filters">${S.actor.role==='admin'?ownerOptions(S,P.owner):''}<label>起始日期<input id="filter-from" type="date" value="${esc(P.from||'')}" aria-label="起始日期"></label><label>结束日期<input id="filter-to" type="date" value="${esc(P.to||'')}" aria-label="结束日期"></label><select id="filter-level" aria-label="客户等级"><option value="">全部客户等级</option>${(S.rules.customer_levels||['A','B','C']).map(l=>`<option value="${esc(l)}" ${P.level===l?'selected':''}>${esc(l)}</option>`).join('')}</select><select id="filter-sale-type" aria-label="销售类型"><option value="">全部销售类型</option>${['新签自建','新签分发','续费','增购'].map(l=>`<option ${P.saleType===l?'selected':''}>${l}</option>`).join('')}</select>${button('重置','reset-filters','','ghost','refresh')}</div>`;
export function dashboard(S,P) {
  if(P.view==='personal'&&!P.owner)P={...P,owner:String(S.actor.id)};
  if(P.from&&P.to&&P.from>P.to)return controls(S,P)+'<p class="form-error" role="alert">起始日期不能晚于结束日期，请调整日期范围。</p>';
  const scoped=dashboardScope(S,P),o=scoped.opportunities,c=scoped.contracts;
  let html='';
  if(P.view==='analytics'||P.view==='personal')html=workbench(scoped,P);
  if(P.view==='funnel') {
    const active=o.filter(x=>!isClosedStage(x.stage)),won=o.filter(x=>isWonStage(x.stage)),ended=o.filter(x=>isWonStage(x.stage)||isLostStage(x.stage));
    const endedAmount=sum(ended,x=>x.amount||0),allAmount=sum(o,x=>x.amount||0);
    html=metrics([['在跟进金额',plainMoney(sum(active,x=>x.amount||0)),'合同总额口径','opportunities'],['赢单金额',plainMoney(sum(won,x=>x.amount||0)),'已归档及历史赢单','contracts'],['金额赢单率',`${endedAmount?Math.round(sum(won,x=>x.amount||0)/endedAmount*100):0}%`,'赢单金额 / 已结束金额','chart'],['风险金额',plainMoney(sum(active.filter(x=>x.risk.level!=='normal'),x=>x.amount||0)),'在跟进商机','alert']])+`<section class="panel">${sectionHead('商机金额漏斗')}${pipeline({...scoped,opportunities:o},false)}<div class="table-scroll"><table class="data-table"><thead><tr><th>阶段</th><th>合同总额</th><th>cash金额</th><th>金额占比</th><th>平均停留</th></tr></thead><tbody>${S.stages.map(stage=>{const list=o.filter(x=>x.stage===stage),amount=sum(list,x=>x.amount||0),known=list.filter(x=>x.product_amount!==null&&x.product_amount!==undefined);return `<tr><td><button class="text-link" data-action="stage-filter" data-id="${esc(stage)}">${esc(stage)}</button></td><td>${plainMoney(amount)}</td><td>${known.length?plainMoney(sum(known,x=>x.product_amount)):'—'}${known.length<list.length?'<span class="record-meta">含未提供金额</span>':''}</td><td>${allAmount?Math.round(amount/allAmount*100):0}%</td><td>${list.length?Math.round(sum(list,x=>x.risk.days||0)/list.length):0} 天</td></tr>`;}).join('')}</tbody></table></div></section><section class="panel">${sectionHead('停滞商机')}${oppTable(S,active.filter(x=>x.risk.level!=='normal').sort((a,b)=>b.risk.days-a.risk.days))}</section>`;
  }
  if(P.view==='assets') {
    const customers=scoped.customers;
    const breakdown=key=>[...new Set(customers.map(c=>c[key]||'未填写'))].map(value=>`<div><span>${esc(value)}</span><b>${customers.filter(c=>(c[key]||'未填写')===value).length} 家</b></div>`).join('');
    html=metrics(['潜在','成交','流失','冻结'].map(status=>[status+'客户',customers.filter(c=>c.status===status).length+' 家','按客户主档当前状态','customers']))+`<div class="dashboard-grid">${[['客户分级','manual_level'],['行业结构','industry'],['区域结构','region'],['集团关系','group_name']].map(([name,key])=>`<section class="panel">${sectionHead(name)}<div class="industry-list">${breakdown(key)}</div></section>`).join('')}</div><section class="panel">${sectionHead('客户互动与集团档案','最近互动来自本次可见跟进记录')}<div class="table-scroll"><table class="data-table"><thead><tr><th>客户</th><th>母公司 / 集团</th><th>最近互动</th><th>状态</th></tr></thead><tbody>${customers.map(c=>`<tr><td><button class="text-link" data-action="customer" data-id="${c.id}">${esc(c.name)}</button></td><td>${esc(c.parent_company||'未填写')}<span class="record-meta">${esc(c.group_name||'未填写集团')}</span></td><td>${esc(c.last_interaction||'尚无记录')}</td><td>${badge(c.status)}</td></tr>`).join('')}</tbody></table></div></section>`;
  }
  return controls(S,P)+html;
}
