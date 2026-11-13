import {policyMatrix} from './commission-policy.js';
import {commissionIssues, isCommissionPending, isMonthlyManagement, commissionBasisLabel, selectCommissionRows, commissionIssueRows, selectCommissionHistory} from './commission-view-model.js';
import { esc, plainMoney, badge, actionButton as button, sectionHead, empty, input, textarea, select, formShell, userName } from '../ui.js';
import { metrics, sum, ownerOptions } from './shared.js';
const percent=v=>(v*100).toLocaleString('zh-CN',{maximumFractionDigits:2})+'%';
const kindName=k=>k==='personal'?'个人提成':'团队管理提成';
const displayedGrade=(S,p)=>p.grade||(p.kind==='personal'&&p.grade_source==='fixed_A'?'A':null);
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const estimated=p=>Object.hasOwn(p,'estimated_total')?p.estimated_total:p.total;
const issueMessage=x=>typeof x==='string'?x:x.message||x.reason||'信息待完善';
const actionableIssue=x=>typeof x==='string'||x.pending!==false;
const whollyPending=p=>!finite(estimated(p));
const amountText=p=>whollyPending(p)?'待完善信息':plainMoney(estimated(p));
const dateText=v=>String(v||'').slice(0,10)||'—';
const periodLabel=value=>/^\d{4}-\d{2}$/.test(value)?value.replace('-',' 年 ')+' 月':/^\d{4}Q[1-4]$/.test(value)?value.replace('Q',' 年第 ')+' 季度':value+' 年';
const canOpenContract=(S,id)=>!!id&&(S.contracts||[]).some(c=>c.id===Number(id));
const contractLink=(S,name,id,cls='ghost')=>canOpenContract(S,id)?button(name||'查看合同','contract',id,cls):`<span class="commission-contract-name">${esc(name||'历史合同')}</span>`;
function periodControl(S,data){
  const selected=data.period||S.today.slice(0,7),monthly=/^\d{4}-\d{2}$/.test(selected);
  const years=[Number(S.today.slice(0,4)),...(data.batches||[]).map(b=>Number(String(b.period).slice(0,4))),...(S.contracts||[]).map(c=>Number(String(c.sign_date||'').slice(0,4))),Number(selected.slice(0,4))].filter(n=>Number.isInteger(n)&&n>=1900);
  const min=Math.max(1900,Math.min(...years)-5),max=Math.min(9999,Math.max(...years)+1),options=[];
  const mode=data.legacy_mode||'quarter';
  for(let y=max;y>=min;y--){if(mode==='year')options.push(String(y));else for(let q=4;q>=1;q--)options.push(`${y}Q${q}`);}
  return `<div class="commission-period-controls">${mode==='month'?'':`<label>计算口径<select id="commission-period-mode" aria-label="提成周期类型"><option value="month" ${monthly?'selected':''}>月度</option><option value="history" ${monthly?'':'selected'}>${mode==='year'?'原年度口径':'原季度口径'}</option></select></label>`}<label>${monthly?'计算月份':'计算周期'}${monthly?`<input id="commission-period" type="month" value="${esc(selected)}" aria-label="计算月份">`:`<select id="commission-period" aria-label="计算周期">${options.map(v=>`<option value="${v}" ${selected===v?'selected':''}>${esc(periodLabel(v))}</option>`).join('')}</select>`}</label></div><div class="commission-period-steps" aria-label="切换计算周期">${button('上一期','commission-previous-period','','secondary')}${button('下一期','commission-next-period','','secondary')}${button(monthly?'本月':mode==='year'?'本年':'本季度','commission-current-period','','secondary')}</div>`;
}
function viewFilters(S,P){
  const status=['all','pending','calculated'].includes(P.commissionStatus)?P.commissionStatus:'all';
  return `<div class="filterbar commission-view-filters"><label>状态<select id="commission-status" aria-label="提成计算状态">${[['all','全部状态'],['pending','待完善 / 暂算'],['calculated','已计算']].map(([v,n])=>`<option value="${v}" ${v===status?'selected':''}>${n}</option>`).join('')}</select></label><label class="commission-search-label"><span class="sr-only">搜索销售、合同或提示</span><input id="commission-search" type="search" value="${esc(P.commissionQ||'')}" placeholder="搜索销售、合同或提示" aria-label="搜索销售、合同或提示" autocomplete="off"></label>${S.actor.role==='admin'?ownerOptions(S,P.owner):''}</div>`;
}
function productTier(p){
  const tier=p.product_tier;
  if(!tier)return '';
  let body='';
  if(tier.status==='basis-incomplete'||!tier.basis_complete)body='产品回款或毛利依据尚未补齐，完整基数确定后显示档位与差距。';
  else if(tier.status==='grade-missing')body='本月绩效等级尚未确定，比例与下一档参考待完善。';
  else if(tier.status==='rate-missing')body='当前档位的提成比例待核实，暂不推算下一档金额。';
  else if(tier.status==='ready'){
    body=`本月产品回款毛利 ${plainMoney(tier.known_base)}，当前 ${tier.current_threshold==null?'':`${plainMoney(tier.current_threshold)} 起档 · `}${percent(tier.rate)}。`;
    if(tier.next_threshold!=null&&tier.distance_to_next!=null)body+=`<br>距下一档还差 <b>${plainMoney(tier.distance_to_next)}</b>${tier.next_rate==null?'，下一档比例待核实':`，达到 ${plainMoney(tier.next_threshold)} 后整月产品基数按 ${percent(tier.next_rate)} 计算`}。`;
    else if(tier.next_rate_pending)body+='<br>下一档比例待核实，暂不推算下一档参考。';
    else if(tier.at_maximum)body+='<br>已达到当前最高档位。';
  }
  return body?`<div class="commission-tier-note"><strong>产品档位</strong><p>${body}</p></div>`:'';
}
function personalReceipts(S,data,p){
  if(p.kind!=='personal'||!/^\d{4}-\d{2}$/.test(p.period))return null;
  if(!Array.isArray(data.receipt_review))return {amount:null,product_amount:null};
  const unique=new Map();let invalid=false;
  for(const receipt of data.receipt_review){
    if(Number(receipt.sales_id)!==Number(p.sales_id)||!receipt.date?.startsWith(p.period+'-')||receipt.date>S.today||receipt.status&&receipt.status!=='已到账')continue;
    if(!Number.isSafeInteger(receipt.payment_id)||!Number.isSafeInteger(receipt.amount)||receipt.amount<0){invalid=true;continue;}
    const prior=unique.get(receipt.payment_id);
    if(prior&&(prior.amount!==receipt.amount||prior.product_amount!==receipt.product_amount))invalid=true;
    unique.set(receipt.payment_id,receipt);
  }
  const rows=[...unique.values()],sum=key=>rows.reduce((total,row)=>total+row[key],0);
  return {amount:invalid?null:sum('amount'),product_amount:invalid||rows.some(row=>row.allocation_valid===false||!Number.isSafeInteger(row.product_amount))?null:sum('product_amount')};
}
function receiptTotal(receipts){
  if(!receipts)return '';
  return `<div class="commission-receipt-total"><span>${receipts.label||'本月实际回款总额'}</span><strong>${receipts.amount==null?'待核对':plainMoney(receipts.amount)}</strong><small>按本月实际到账统计</small></div>`;
}
function componentCards(p,receipts){
  if(isMonthlyManagement(p)){
    const missingBase=p.base==null||whollyPending(p)&&p.base===0;
    const rate=p.rate==null?'待核实':`${percent(p.rate)}${p.rate_pending?'（暂算）':''}`;
    const sources=(p.components||[]).map(c=>`<small>${c.type==='product'?'产品回款毛利':'开发运维回款毛利'} ${c.base==null?'待补充':plainMoney(c.base)}</small>`).join('');
    return `<div class="commission-component"><span>${p.amount_pending?'已知':''}当月回款毛利</span><b>${missingBase?'待补充':plainMoney(p.base)}</b>${sources}</div><div class="commission-component"><span>计提比例</span><b>${rate}</b><small>按当月回款毛利合计选档</small></div>`;
  }
  if(!p.components){
    const missingBase=p.base==null||whollyPending(p)&&p.base===0,incompleteBase=(p.lines||[]).some(l=>l.base==null);
    return `<div class="commission-component"><span>${incompleteBase?'已知累计毛利':'累计毛利'}</span><b>${missingBase?'待补充':plainMoney(p.base)}</b><small>计提比例 ${p.rate==null?'待核实':percent(p.rate)}</small></div>`;
  }
  return p.components.map(c=>{
    const value=Object.hasOwn(c,'estimated_total')?c.estimated_total:c.total,known=finite(value);
    const incomplete=c.amount_pending||c.partial||c.provisional,product=c.type==='product';
    const label=product?'产品提成':c.type==='service'?'开发运维提成':c.label;
    const basis=product?'产品回款毛利合计':'开发运维回款合计';
    const missingBase=c.base==null||c.total==null&&c.base===0&&c.amount_pending;
    const rate=c.rate==null?(c.type==='service'&&p.policy?.service_aggregation==='contract'?'逐合同选档':'待核实'):percent(c.rate);
    return `<div class="commission-component" data-component="${esc(c.type)}"><span>${esc(label)}${incomplete?'<small class="commission-inline-note">暂算</small>':''}</span><b>${known?plainMoney(value):'待完善信息'}</b>${product&&receipts?`<small>产品实际回款 ${receipts.product_amount==null?'待核对分配':plainMoney(receipts.product_amount)}</small>`:''}<small>${incomplete?'已知':''}${basis} ${missingBase?'待补充':plainMoney(c.base)}</small><small>提成比例 ${rate}</small></div>`;
  }).join('');
}
const issueTitles={
  receipt_split_missing:'产品回款待分配',receipt_split_exceeded:'回款分配需核对',receipt_date_missing:'到账日期待补充',source_claim:'到账依据待核对',receipt_source_claim:'到账流水待核对',source_basis:'合同来源待核对',source_split:'合同明细待补齐',contract_split_missing:'合同明细待完善',contract_split_invalid:'合同明细待完善',contract_items_incomplete:'合同明细待完善',margin_missing:'毛利待补充',performance_missing:'绩效待完善',service_scope_unconfirmed:'服务口径待确定',rate_missing:'提成比例待核实',commission_policy_pending:'管理口径待确定',legacy_rate_pending:'管理口径待确定',legacy_settlement:'历史口径待核对',contract_terminated:'合同已终止',product_basis_incomplete:'产品月度基数待补齐'
};
const actionNames={'payment-allocation':'补充回款信息','contract-items':'完善合同明细',performance:'查看绩效','sales-policy':'维护个人规则','manager-policy':'维护管理规则',contract:'查看合同'};
function issueAction(S,item){
  const action=item.action||'contract',contractId=item.contract_id;
  if(S.actor.role!=='admin'&&item.responsibility==='admin')return '<span class="commission-responsibility">由管理员处理</span>';
  if(['contract','contract-items','payment-allocation'].includes(action)&&!canOpenContract(S,contractId))return '<span class="commission-responsibility">查看历史依据核对</span>';
  if(S.actor.role!=='admin'&&(item.can_handle===false||Number(item.sales_id)!==S.actor.id))return '<span class="commission-responsibility">请联系资料负责人处理</span>';
  return `<button type="button" class="btn secondary commission-issue-action" data-action="commission-issue" data-id="${esc(contractId||'')}" data-issue-action="${esc(action)}" data-issue-code="${esc(item.code||'')}" data-sales-id="${esc(item.sales_id)}" data-period="${esc(item.period)}" data-task-key="${esc(item.key)}">${esc(item.action_label||actionNames[action]||'查看依据')}</button>`;
}
function issueReceipt(item){
  if(item.payment_id==null)return '';
  const dates=[`实际到账 ${item.payment_date||'日期待补'}`,item.sign_date&&`合同签约 ${item.sign_date}`].filter(Boolean);
  const affected=item.affected_payment_ids||[];
  const related=affected.length?`<small>受影响的后续流水 ${esc(affected.map(id=>`#${id}`).join('、'))}</small>`:'';
  return `<small class="commission-task-receipt">收款 #${esc(item.payment_id)} · 实收 ${plainMoney(item.payment_amount)} · ${esc(dates.join(' · '))}</small>${related}`;
}
function issueQueue(S,P,kind){
  const tasks=commissionIssueRows(S,P).filter(task=>task.kind===kind);
  if(!tasks.length)return '';
  const render=item=>`<article class="commission-task" data-issue-code="${esc(item.code||'')}"><div class="commission-task-main"><div class="commission-task-heading"><strong>${esc(item.contracts.length===1?item.contracts[0].title:item.title)}</strong>${badge(item.impact,'warning')}</div><p><b>${esc(item.title)}。</b>${esc(item.detail)}</p>${issueReceipt(item)}<p class="commission-task-impact">${esc(item.impact_message)}</p>${item.contracts.length>1?`<div class="commission-task-contracts">${item.contracts.map(c=>`<span>${esc(c.title)}</span>`).join('')}</div>`:''}<small>资料负责人：${esc(item.responsible_label)} · 提成人：${esc(item.sales_name)} · ${esc(periodLabel(item.period))}</small></div><div class="commission-task-action">${issueAction(S,item)}</div></article>`;
  return `<div class="commission-queue" data-issue-kind="${esc(kind)}"><div class="commission-queue-heading">需补充资料 <span class="commission-count">${tasks.length} 项</span></div><div class="commission-task-list">${tasks.slice(0,4).map(render).join('')}</div>${tasks.length>4?`<details class="commission-queue-more"><summary>展开其余 ${tasks.length-4} 项</summary><div class="commission-task-list">${tasks.slice(4).map(render).join('')}</div></details>`:''}</div>`;
}
function compactIssues(S,p){
  const notices=commissionIssues(p).filter(x=>!actionableIssue(x));
  if(!notices.length)return '';
  return `<details class="commission-person-issues is-notice"><summary>计算说明 · ${notices.length} 条</summary>${notices.map(issue=>`<div class="commission-issue-row"><div><span>${esc(issueMessage(issue))}</span></div></div>`).join('')}</details>`;
}
function calculationDetail(S,p){
  const lines=p.lines||[],team=isMonthlyManagement(p);
  return `<details class="commission-calculation"><summary>查看计算与合同依据（${lines.length} 项）</summary><div class="commission-detail-body">${p.components?p.components.map(c=>`<p><b>${esc(c.label)}</b> · ${esc(c.basis||'')} · ${c.amount_pending||c.partial||c.provisional?'暂算，部分依据待完善':'按当前规则计算'}</p>`).join(''):''}${lines.map(l=>{
    const value=Object.hasOwn(l,'entitlement')?l.entitlement:l.rate==null||!finite(l.base)?null:Math.round(l.base*l.rate);
    const scope=l.component==='unknown'?'计提口径待补充':team?'按团队当月回款毛利合计选档':l.component==='service'?(l.tier_scope==='month'||p.policy?.service_aggregation==='month'?'按月合计选档':'按本合同服务额选档'):l.component==='product'?'按月合计选档':'按原累计毛利口径';
    const basis=l.component==='legacy'?'毛利':commissionBasisLabel(p,l);
    const formula=l.component==='unknown'?`合同总额 ${l.base==null?'待补充':plainMoney(l.base)} · 计提基数待明确`:`${basis} ${l.base==null?'待补充':plainMoney(l.base)} × ${l.rate==null?'待核实':percent(l.rate)}`;
    return `<div class="commission-calculation-line"><div>${contractLink(S,`${l.contract_name} · ${l.product||''}`,l.contract_id)}<small>${formula}</small><small>${scope}</small></div><b>${value==null?'待完善信息':plainMoney(value)}${l.provisional?'<small>暂算</small>':''}</b></div>`;
  }).join('')||'<p class="muted">本周期暂无可计算明细。</p>'}${p.scenarios&&!p.grade&&whollyPending(p)&&(p.lines||[]).some(l=>l.item_id!=null&&l.base>0)?`<details class="commission-scenarios"><summary>查看不同绩效等级的参考金额</summary><p class="muted">${p.scenarios.map(v=>`${esc(v.grade)}：${v.product==null||v.service==null?'比例待核实':plainMoney(v.product+v.service)}`).join('；')}。以上仅按当前已知基数参考，不包含缺失依据的金额。</p></details>`:''}</div></details>`;
}
function commissionCard(S,data,p){
  const isPending=isCommissionPending(p),personal=p.kind==='personal',grade=personal?displayedGrade(S,p):null,value=estimated(p),explicit=p.calculated_total;
  const team=isMonthlyManagement(p),receipts=team?{amount:p.received_amount,label:'团队本月实际回款总额'}:personalReceipts(S,data,p);
  const calculatedMessage=team?'按当月实际到账与回款毛利计算':personal?'按当前合同、回款与绩效计算':'按原周期毛利口径计算';
  const breakdown=finite(value)&&finite(explicit)&&value!==explicit?`明确依据可算 ${plainMoney(explicit)}，其余为暂算`:finite(value)&&p.amount_pending?'另有信息待完善，完整合计待补齐':'';
  return `<article class="commission-person-card" data-sales-id="${p.sales_id}" data-commission-kind="${esc(p.kind)}"><div class="commission-person-head"><div><h3>${esc(p.name)} ${grade?badge(`${grade}级`,'blue'):personal&&p.components?badge('绩效待完善','warning'):''}</h3><p>${kindName(p.kind)} · ${esc(periodLabel(p.period))}${p.inactive?' · 已停用':''}</p></div><div class="commission-current-amount"><span>${whollyPending(p)?'当前金额':p.amount_pending?'已算部分':isPending?'当前暂算':'实时提成'}</span><strong class="${whollyPending(p)?'is-pending':''}">${amountText(p)}</strong></div></div>${receiptTotal(receipts)}<div class="commission-components">${componentCards(p,receipts)}</div>${breakdown?`<p class="commission-amount-breakdown">${esc(breakdown)}</p>`:''}${personal?productTier(p):''}<div class="commission-person-summary"><span>${badge(whollyPending(p)?'待完善':isPending?'暂算':'已计算',isPending?'warning':'success')}${isPending?'补充信息后金额更新':calculatedMessage}</span></div>${compactIssues(S,p)}${calculationDetail(S,p)}</article>`;
}
function historyRecords(S,data,P){
  const available=(data.batches||[]).filter(b=>(S.actor.role==='admin'||b.sales_id===S.actor.id)&&(S.actor.role!=='admin'||!P.owner||b.sales_id===Number(P.owner)));
  if(!available.length)return '';
  const selected=P.commissionHistoryPeriod||data.period,periods=[...new Set([selected,...available.map(b=>b.period)])].sort().reverse(),rows=selectCommissionHistory(S,P);
  return `<section class="panel commission-history"><details><summary>查看历史记录 · 仅供查阅</summary><p class="muted">历史金额与当时的计算依据保持原样，不计入当前实时合计。</p><div class="commission-history-filter"><label>历史记录周期<select id="commission-history-period" aria-label="历史记录周期">${periods.map(v=>`<option value="${esc(v)}" ${v===selected?'selected':''}>${esc(periodLabel(v))}</option>`).join('')}</select></label><span>${rows.length} 笔 · 按实际周期筛选</span></div>${rows.map(b=>`<details class="commission-history-entry"><summary><span>${esc(userName(S,b.sales_id))} · ${kindName(b.kind)} · ${esc(periodLabel(b.period))}</span><strong>${plainMoney(b.amount)}</strong><small>${b.status==='paid'?'历史已发放':'历史已确认'} · ${esc(dateText(b.paid_at||b.created_at))}</small></summary><div class="commission-detail-body">${b.paid_note?`<p>原备注：${esc(b.paid_note)}</p>`:''}${b.snapshot?.grade?`<p>原绩效 ${esc(b.snapshot.grade)}</p>`:''}${(b.snapshot?.lines||[]).map(l=>`<div class="commission-calculation-line"><div>${contractLink(S,l.contract_name||'历史合同',l.contract_id)}<small>${l.base==null?'基数待核实':plainMoney(l.base)} × ${l.rate==null?'比例待核实':percent(l.rate)}</small></div><b>${l.amount==null?'待核实':plainMoney(l.amount)}</b></div>`).join('')||'<p class="muted">该历史记录没有逐项计算明细。</p>'}</div></details>`).join('')||'<p class="commission-empty">当前周期及筛选条件下暂无历史记录，可选择其他历史周期查看。</p>'}</details></section>`;
}
function policyDetails(S,rule,policy){
  if(!policy&&S.actor.role!=='admin')return '';
  return `<section class="panel commission-rules"><details><summary>查看提成规则与梯度</summary>${policy?`${sectionHead('销售个人提成梯度','达到档位后，整笔基数乘对应比例。',S.actor.role==='admin'?button('调整个人提成梯度','sales-commission-policy','','secondary','edit'):'')}${policyMatrix(policy,'product')}${policyMatrix(policy,'service')}<p class="panel-copy">产品按当月实际回款毛利合计选档。开发运维${policy.service_scope_confirmed?'按':'范围待定，暂按'}${policy.service_aggregation==='contract'?'每份合同的实际服务回款':'当月实际服务回款合计'}选档。空白比例保留待核实。个人规则自 ${esc(policy.effective_month)} 起适用。</p>`:''}${S.actor.role==='admin'?`${sectionHead('团队管理提成','每月按其他参与计提销售的实际回款毛利选档。',button('调整团队提成规则','finance-rules','','secondary','edit'))}<p class="panel-copy">当月回款毛利合计不超过 ${plainMoney(rule.threshold)} 时，全额按 ${percent(rule.low_rate)} 计提。超过阈值时，全额按 ${percent(rule.high_rate)} 计提。</p>`:''}</details></section>`;
}

function commissionMetric(rows, completeNote) {
  if(!rows.length)return ['—','当前筛选无记录'];
  const amounts=rows.map(estimated).filter(finite);
  if(!amounts.length)return ['待完善信息','补充信息后更新'];
  const note=amounts.length<rows.length?'已算部分，完整金额待补齐':rows.some(isCommissionPending)?'含暂算或待完善项':completeNote;
  return [plainMoney(sum(amounts,amount=>amount)),note];
}

export function commissions(S,P={}) {
  const data=S.commission,rule=S.rules.commission||{},previews=data.realtime_previews||data.previews||[],policy=rule.sales_policy||previews.find(p=>p.policy)?.policy;
  const rows=selectCommissionRows(S,P),management=rows.filter(p=>p.kind==='management'),personal=rows.filter(p=>p.kind==='personal');
  const admin=S.actor.role==='admin';
  const componentMetric=type=>{
    const components=personal.flatMap(p=>(p.components||[]).filter(c=>c.type===type));
    if(!components.length)return ['—','当前周期按毛利口径查看'];
    const total=sum(components,c=>finite(c.total)?c.total:0),unknown=components.some(c=>c.amount_pending||c.partial||c.total==null),noneKnown=components.every(c=>c.total==null);
    return [noneKnown?'待完善信息':plainMoney(total),unknown?'已算部分，完整金额待补齐':type==='product'?'按产品实际回款毛利计算':'按开发运维实际回款计算'];
  };
  const updated=data.updated_at&&Number.isFinite(Date.parse(data.updated_at))?new Date(data.updated_at).toLocaleTimeString('zh-CN',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'}):'';
  const product=componentMetric('product'),service=componentMetric('service'),monthly=/^\d{4}-\d{2}$/.test(data.period),tasks=commissionIssueRows(S,P);
  const managementBasis=monthly?`${periodLabel(data.period)} · 按其他销售实际到账的产品与开发运维毛利选档`:'按原累计毛利口径查看';
  const [personalValue,personalNote]=commissionMetric(personal,'按最新业务计算');
  const summary=[
    [admin?'个人实时提成':'我的实时提成',personalValue,`${esc(periodLabel(data.period))} · ${personalNote}`,'wallet'],
    ['产品提成',...product,'contracts'],
    ['开发运维提成',...service,'check'],
    ['待处理事项',String(tasks.length),`${new Set(tasks.map(t=>t.sales_id)).size} 位成员 · 普通说明不计入`,'clock'],
  ];
  if(admin){
    const [totalValue,totalNote]=commissionMetric([...personal,...management],'个人提成 + 团队管理提成');
    const [teamValue,teamNote]=commissionMetric(management,monthly?'按当月回款毛利计算':'按原累计毛利口径计算');
    const teamLink=management.length?' <button type="button" class="text-link commission-management-link" data-action="commission-management-detail">查看团队明细</button>':'';
    summary.unshift(
      ['实时提成合计',totalValue,totalNote,'wallet'],
      ['团队管理提成',teamValue,teamNote+teamLink,'team'],
    );
  }
  const metricsHtml=admin?`<div class="commission-summary-with-team">${metrics(summary)}</div>`:metrics(summary);
  return `<div class="commission-live"><section class="panel commission-toolbar">${sectionHead(S.actor.role==='admin'?'团队提成工作台':'我的提成','按最新业务实时计算；有疑问的合同单独列出，不影响其他明确金额。')}<p class="commission-update-status">自动更新${updated?` · 更新于 ${esc(updated)}`:''}</p><div class="filterbar commission-filters">${periodControl(S,data)}${button('刷新金额','commission-refresh','','secondary','refresh')}</div>${viewFilters(S,P)}<p class="commission-filter-scope">${S.actor.role==='admin'?'筛选当前显示的人员及其完整当期金额':'仅展示本人数据'} · 实时合计、合同依据和待完善清单采用相同筛选条件。</p></section>${metricsHtml}<section class="panel commission-overview">${sectionHead(S.actor.role==='admin'?'个人提成':'我的提成明细',monthly?`${periodLabel(data.period)} · 产品按实际回款毛利、开发运维按实际回款`:'按原累计毛利口径查看，非月度提成汇总')}${policy&&monthly&&data.period<policy.effective_month?`<p class="commission-period-note">该月份早于个人规则生效时间 ${esc(policy.effective_month)}，个人提成按现行口径作参考。</p>`:''}<div class="commission-card-list">${personal.map(p=>commissionCard(S,data,p)).join('')||'<p class="commission-empty">当前筛选条件下没有匹配的个人提成记录，可调整人员、状态或搜索内容。</p>'}</div>${issueQueue(S,P,'personal')}</section>${management.length?`<section class="panel commission-management">${sectionHead('团队管理提成',managementBasis)}<div class="commission-card-list">${management.map(p=>commissionCard(S,data,p)).join('')}</div>${issueQueue(S,P,'management')}</section>`:''}${historyRecords(S,data,P)}${monthly?`<section class="panel commission-receipt-section"><details><summary>查看当月实际到账依据</summary>${receiptReview(S,data,rows)}</details></section>`:''}${policyDetails(S,rule,policy)}</div>`;
}
export {performance,syncPerformanceReviewPreview,performanceQuoteDetail,selectPerformanceRows} from './performance-view.js';
export function formIncentives(S,type,id) {
  if(type==='performance-review') {
    if(S.actor.role!=='admin')return empty('无权设置绩效','仅管理员可以设置和确认绩效。');
    const p=S.performance.find(p=>p.user_id===Number(id));
    if(!p?.eligible)return empty('该成员不参与绩效评定','请选择在用且参与绩效的一线销售。');
    if(p.status==='confirmed')return empty('该月绩效已确认锁定','已确认的评分和计算依据保留，不可修改。');
    const cap=S.rules.performance.cap;
    return formShell('设置绩效',`${p.name} · ${p.month}。当月可保存设置，结束月份可确认并锁定。`,
      `<input type="hidden" name="month" value="${esc(p.month)}"><div class="wide form-context">系统过程分 ${esc(p.automatic_raw??p.process.raw)} / ${esc(cap)}。填写过程分将替代系统过程分；最终总分可单独设置。清空人工分可恢复自动评分，恢复时也需记录原因。</div>`+
      `<div class="wide">${input('adjustment','计入过程分（留空使用系统分）',p.adjustment??'','number',false,`min="0" max="${esc(cap)}" step="0.01"`)}</div>`+
      input('final_score','最终总分（留空使用两项合计）',p.final_score??'','number',false,'min="0" max="100" step="0.01"')+textarea('reason','设置或恢复原因',p.reason,p.adjustment!=null||p.final_score!=null)+
      '<div class="wide performance-review-preview" data-performance-review-preview aria-live="polite"></div>'+
      `<div class="wide">${select('status','保存方式',[['draft','保存设置，暂不锁定'],...(p.month<S.today.slice(0,7)?[['confirmed','确认并锁定本月']]:[])], 'draft')}</div>`,type,id,'保存设置');
  }
}

function receiptReview(S,data,rows){
 if(!/^\d{4}-\d{2}$/.test(data.period))return '';
 const salesIds=new Set(rows.filter(p=>p.kind==='personal').map(p=>p.sales_id));
 const teamReceiptIds=new Set(rows.filter(isMonthlyManagement).flatMap(p=>(p.evidence||[]).map(receipt=>receipt.payment_id)));
 const receipts=(data.receipt_review||[]).filter(x=>(salesIds.has(x.sales_id)||teamReceiptIds.has(x.payment_id))&&(S.actor.role==='admin'||x.sales_id===S.actor.id));
 return `<section class="panel">${sectionHead('当月实际到账依据',`${data.period} · ${receipts.length} 笔 · 合计 ${plainMoney(sum(receipts,p=>p.amount))}`)}<div class="table-scroll"><table class="data-table"><thead><tr><th>关联合同</th><th>销售</th><th>到账日期</th><th>本笔到账</th><th>其中产品</th><th>其中服务</th><th>核对事项</th></tr></thead><tbody>${receipts.map(p=>`<tr><td>${contractLink(S,p.contract_no||p.contract_name,p.contract_id)}</td><td>${esc(p.sales_name)}</td><td>${esc(p.date)}</td><td>${plainMoney(p.amount)}</td><td>${p.product_amount==null?'待分配':plainMoney(p.product_amount)}</td><td>${p.service_received==null?'待分配':plainMoney(p.service_received)}</td><td>${esc((p.issues||[]).join('；')||'到账依据已列示，请结合实时计算提示查看')}</td></tr>`).join('')||'<tr><td colspan="7">当前筛选条件下没有当月到账流水。</td></tr>'}</tbody></table></div></section>`;
}
