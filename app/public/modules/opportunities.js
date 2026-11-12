import {monthlyBoard} from './monthly-board.js';
import {contractStatusLabel} from './contract-status.js';
import {canManageContractData} from './contract-access.js';
import {linkedMinutes} from './minutes.js';
import {salesAdvicePanel} from './sales-advice-ui.js';
import {quoteRecord} from './quotes.js';
import {esc,icon,plainMoney,dateLabel,shortDate,userName,salesName,avatar,badge,stageBadge,stageRail,riskBadge,actionButton as button,sectionHead,empty,select,input,textarea,formShell,isClosedStage,isWonStage,isLostStage} from '../ui.js';
import {sum,filtered,filters,timeline,needsFollowup,selectOpportunities,ownerOptions} from './shared.js';

const salesTypes=['新签自建','新签分发','续费','增购'];
const orderTypes=['代销','经销','千帆'];
const optionalMoney=value=>value===null||value===undefined?'未提供':plainMoney(value);
const listStages=['赢单','商务','方案','需求','线索','输单','搁置'];
const listSortFields=new Set(['amount','product_amount','service_amount','created_at']);
const knownAmount=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));
const stageRank=stage=>listStages.includes(stage)?listStages.indexOf(stage):listStages.length;
const createdTimestamp=value=>value&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const listMoney=value=>knownAmount(value)?plainMoney(value):'未提供';
const forecastAmount=o=>Object.hasOwn(o,'forecast_amount')?o.forecast_amount:o.amount;
const forecastProduct=o=>Object.hasOwn(o,'forecast_product_amount')?o.forecast_product_amount:o.product_amount;
const canEdit=(S,o)=>S.actor.role==='admin'||S.actor.role==='sales'&&Number(o.owner_id)===Number(S.actor.id);
const customerLabel=(S,o)=>S.customers.find(c=>Number(c.id)===Number(o.customer_id))?.name||(o.customer_id==null?'待补充客户':'客户');

// Amounts in state are integer cents. Preserve missing historical values instead of assuming zero.
export const opportunityServiceAmount=o=>knownAmount(forecastAmount(o))&&knownAmount(forecastProduct(o))?Number(forecastAmount(o))-Number(forecastProduct(o)):null;

function compareOptional(a,b,desc=false) {
  if(a==null||b==null)return (a==null?1:0)-(b==null?1:0);
  return (a-b)*(desc?-1:1);
}
function sortValue(o,field) {
  if(field==='created_at')return createdTimestamp(o.created_at);
  if(field==='service_amount')return opportunityServiceAmount(o);
  const value=field==='amount'?forecastAmount(o):field==='product_amount'?forecastProduct(o):o[field];
  return knownAmount(value)?Number(value):null;
}
function compareOpportunities(a,b,P) {
  const stage=stageRank(a.stage)-stageRank(b.stage);
  if(stage)return stage;
  const field=listSortFields.has(P.sort)?P.sort:'created_at',desc=listSortFields.has(P.sort)?!!P.desc:true;
  return compareOptional(sortValue(a,field),sortValue(b,field),desc)||
    compareOptional(createdTimestamp(a.created_at),createdTimestamp(b.created_at),true)||
    String(a.id).localeCompare(String(b.id),'zh-CN',{numeric:true});
}

export function opportunityGroups(S,list,P={}) {
  const groups=new Map();
  for(const o of list) {
    const owner=o.owner_id==null||o.owner_id===''?null:String(o.owner_id),key=owner??(o.owner_label?'source:'+o.owner_label:'unassigned');
    if(!groups.has(key)) {
      const user=owner==null?null:S.users.find(u=>String(u.id)===owner);
      groups.set(key,{key,owner_id:owner,name:user?.name||o.owner_label||(owner==null?'未分配销售小二':`未识别销售（编号 ${owner}）`),known:!!user,rows:[]});
    }
    groups.get(key).rows.push(o);
  }
  return [...groups.values()].sort((a,b)=>Number(b.known)-Number(a.known)||a.name.localeCompare(b.name,'zh-CN')||a.key.localeCompare(b.key,'zh-CN',{numeric:true}))
    .map(group=>({...group,rows:group.rows.sort((a,b)=>compareOpportunities(a,b,P))}));
}

function createdLabel(value) {
  if(!value)return '未提供';
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return dateLabel(value);
  const timestamp=createdTimestamp(value);
  return timestamp==null?String(value):new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(timestamp);
}
function sortHeading(label,field,P) {
  const active=P.sort===field||!listSortFields.has(P.sort)&&field==='created_at',desc=listSortFields.has(P.sort)?!!P.desc:true;
  return `<th scope="col"${active?` aria-sort="${desc?'descending':'ascending'}"`:''}><button data-action="sort" data-id="${field}" title="同一销售、同一阶段内排序">${label} ${icon('sort')}${active?`<span aria-hidden="true">${desc?'↓':'↑'}</span>`:''}</button></th>`;
}
export function opportunityListTable(S,list,P={}) {
  if(!list.length)return empty('没有匹配的商机','可调整筛选条件。');
  const groups=opportunityGroups(S,list,P);
  return `<div class="table-scroll opportunity-list-scroll" tabindex="0" role="region" aria-label="商机总表，可横向滚动"><table class="data-table opportunity-list-table"><thead><tr><th scope="col">客户名称</th><th scope="col">售卖产品</th><th scope="col">商机阶段</th>${sortHeading('预计商机金额','amount',P)}${sortHeading('预计产品金额','product_amount',P)}${sortHeading('预计项目 / 服务金额','service_amount',P)}<th scope="col">销售小二</th><th scope="col">订单类型</th>${sortHeading('创建时间','created_at',P)}</tr></thead>${groups.map(group=>`<tbody data-owner-id="${esc(group.owner_id??'')}"><tr class="opportunity-group-heading"><th scope="rowgroup" colspan="9"><div>${avatar(group.name,true)}<span>${esc(group.name)}</span><span class="opportunity-group-count">${group.rows.length} 条商机</span></div></th></tr>${group.rows.map(o=>{
    const customer=S.customers.find(c=>c.id===Number(o.customer_id)),customerLabel=customer?.name||customer?.short_name||(o.customer_id==null?'待补充客户':'客户');
    return `<tr class="record-row" tabindex="0" data-action="opportunity" data-id="${esc(o.id)}" aria-label="查看${esc(customerLabel)}的${esc(o.name||'未提供产品')}商机"><td class="opportunity-customer"><span class="record-title company-title">${esc(customerLabel)}</span></td><td class="opportunity-product">${esc(o.name||'未提供')}</td><td>${stageBadge(o.stage||'未提供')}</td><td class="number strong">${listMoney(forecastAmount(o))}</td><td class="number">${listMoney(forecastProduct(o))}</td><td class="number">${listMoney(opportunityServiceAmount(o))}</td><td>${esc(group.name)}</td><td>${esc(o.order_type||'未提供')}</td><td class="opportunity-created">${esc(createdLabel(o.created_at))}</td></tr>`;
  }).join('')}</tbody>`).join('')}</table></div>`;
}
function riskReasons(o){
  const values=(o.risk_reasons||o.diagnostics||[]).map(x=>typeof x==='string'?x:x.message).filter(Boolean);
  if(!values.length&&o.risk?.level&&o.risk.level!=='normal')values.push(o.risk.label);
  return [...new Set(values)];
}
function riskSummary(o,compact=false){
  const reasons=riskReasons(o);
  if(!reasons.length)return riskBadge({...o,risk:o.risk||{level:'normal'}});
  return `<div class="opportunity-risk-list">${(compact?reasons.slice(0,2):reasons).map(message=>badge(message,o.risk?.level==='critical'?'danger':'warning')).join('')}${compact&&reasons.length>2?`<span class="opportunity-more-risk">另 ${reasons.length-2} 项</span>`:''}</div>`;
}
function followLabel(S,o){
  if(!o.follow_date)return '待安排日期';
  const label=o.follow_date===S.today?'今天':dateLabel(o.follow_date);
  return o.follow_date<S.today?label+' · 已逾期':label;
}
function workActions(S,o){
  return button('跟进','new-activity',o.id,'secondary','note')+(canEdit(S,o)&&!isWonStage(o.stage)&&!isLostStage(o.stage)?button('阶段','opportunity-stage',o.id,'ghost','edit'):'');
}
function workAmount(o){
  const estimate=forecastAmount(o),actual=o.signed_summary;
  return isWonStage(o.stage)&&actual?`<strong>${optionalMoney(actual.amount)}</strong><small>当前有效签约</small><small class="opportunity-signed-inline">初始登记预估 ${optionalMoney(estimate)}</small>`:`<strong>${optionalMoney(estimate)}</strong><small>预计商机金额</small>${actual?.count>0?`<small class="opportunity-signed-inline">有效签约 ${optionalMoney(actual.amount)}</small>`:''}`;
}
export function opportunityWorkList(S,list){
  if(!list.length)return empty('没有匹配的商机','可切换商机范围，或调整搜索和筛选条件。');
  const table=`<div class="table-scroll opportunity-work-scroll"><table class="data-table opportunity-work-table"><thead><tr><th>客户 / 售卖产品</th><th>预计 / 有效签约</th><th>阶段 / 提醒</th><th>下一步行动 / 跟进时间</th><th>预计签约</th><th>销售</th><th>操作</th></tr></thead><tbody>${list.map(o=>`<tr data-opportunity-id="${o.id}"><td><button class="text-link opportunity-work-title" data-action="opportunity" data-id="${o.id}">${esc(customerLabel(S,o))}</button><span class="record-meta">${esc(o.name||'售卖产品待补充')}</span><small class="opportunity-code">${esc(o.code||'编号待补充')}</small></td><td class="opportunity-work-amount">${workAmount(o)}</td><td>${stageBadge(o.stage)}${riskSummary(o,true)}</td><td class="opportunity-work-action"><span>${esc(o.next_action||'下一步未安排')}</span><small class="${o.follow_date&&o.follow_date<S.today?'text-warning':''}">${esc(followLabel(S,o))}</small></td><td>${esc(o.expected_date?dateLabel(o.expected_date):'待确认')}<small class="record-meta">${esc(o.last_interaction?'最近沟通 '+dateLabel(o.last_interaction):'尚无沟通记录')}</small></td><td>${esc(salesName(S,o))}</td><td><div class="opportunity-row-actions">${workActions(S,o)}</div></td></tr>`).join('')}</tbody></table></div>`;
  const cards=`<div class="opportunity-work-cards">${list.map(o=>`<article class="opportunity-work-card" data-opportunity-id="${o.id}"><header><div><button class="text-link" data-action="opportunity" data-id="${o.id}">${esc(customerLabel(S,o))}</button><p>${esc(o.name||'售卖产品待补充')}</p></div>${stageBadge(o.stage)}</header><div class="opportunity-card-amount">${workAmount(o)}</div>${riskSummary(o,true)}<div class="opportunity-card-next"><span>下一步行动</span><p>${esc(o.next_action||'下一步未安排')}</p><small class="${o.follow_date&&o.follow_date<S.today?'text-warning':''}">${esc(followLabel(S,o))}</small></div><dl><div><dt>预计签约</dt><dd>${esc(o.expected_date?dateLabel(o.expected_date):'待确认')}</dd></div><div><dt>销售</dt><dd>${esc(salesName(S,o))}</dd></div></dl><footer>${workActions(S,o)}</footer></article>`).join('')}</div>`;
  return table+cards;
}
function workFilters(S,P){
  return `<div class="filterbar opportunity-work-filters"><label class="list-search">${icon('search')}<input id="list-search" value="${esc(P.q||'')}" placeholder="搜索客户、售卖产品或商机编号" aria-label="搜索当前列表"></label><div class="filter-selects"><select id="filter-stage" aria-label="筛选阶段"><option value="">全部阶段</option>${S.stages.map(stage=>`<option value="${esc(stage)}" ${P.stage===stage?'selected':''}>${esc(stage)}</option>`).join('')}</select>${S.actor.role==='admin'?ownerOptions(S,P.owner||''):''}<select id="opportunity-sort" aria-label="商机推进排序">${[['priority','优先处理'],['follow_date','跟进日期'],['expected_date','预计签约日期'],['amount','预计金额从高到低']].map(([value,label])=>`<option value="${value}" ${(P.opportunitySort||'priority')===value?'selected':''}>${label}</option>`).join('')}</select>${button('重置筛选','reset-filters','','ghost','refresh')}</div></div>`;
}
export function opportunities(S,P={}) {
  const mode=P.opportunityView==='ledger'?'ledger':'work',risk=P.risk||(mode==='work'?'active':'all');
  const scope=selectOpportunities(S,{...P,opportunityView:mode,risk:'all'}),list=selectOpportunities(S,{...P,opportunityView:mode,risk}),active=scope.filter(o=>!isClosedStage(o.stage));
  const totalRows=list,known=totalRows.filter(o=>knownAmount(forecastAmount(o))),unknown=totalRows.length-known.length;
  const tabs=[['all','全部商机',scope.length],['active','进行中',active.length],['won','赢单',scope.filter(o=>isWonStage(o.stage)).length],['today','待跟进',selectOpportunities(S,{...P,opportunityView:mode,risk:'today'}).length],['risk','风险商机',active.filter(o=>riskReasons(o).length||o.risk?.level&&o.risk.level!=='normal').length]];
  const carried=P.customerLevel||P.saleType||P.from||P.to;
  return `<link rel="stylesheet" href="./modules/opportunities.css">${monthlyBoard(S,P,'opportunity')}<nav class="opportunity-view-switch" aria-label="商机视图">${[['work','推进视图'],['ledger','商机总表']].map(([id,label])=>`<button type="button" data-action="opportunity-view" data-id="${id}" aria-pressed="${mode===id}" class="${mode===id?'active':''}">${icon(id==='work'?'arrow':'contracts')}${label}</button>`).join('')}<span>${mode==='work'?'围绕当前行动安排，按优先级推进':'按销售分组，保留完整商机台账'}</span></nav>${carried?`<p class="form-context">沿用看板筛选：${esc([P.customerLevel&&'客户'+P.customerLevel+'级',P.saleType,(P.from||P.to)&&`${P.from||'最早记录'} 至 ${P.to||'最新记录'}创建的商机`].filter(Boolean).join(' · '))}。可点击重置筛选查看全部。</p>`:''}<div class="list-summary opportunity-summary"><div class="segment">${tabs.map(([value,label,count])=>`<button type="button" data-action="risk-filter" data-id="${value}" class="${risk===value?'selected':''}">${label} <b>${count}</b></button>`).join('')}</div><span>${unknown?'已知':''}预计金额 <b>${plainMoney(sum(known,o=>Number(forecastAmount(o))))}</b>${unknown?`<small>另 ${unknown} 条待评估</small>`:''}</span></div><section class="panel opportunity-list-panel">${mode==='work'?workFilters(S,P)+opportunityWorkList(S,list):filters(S,P,'opportunities')+opportunityListTable(S,list,P)}<div class="table-footer">共 ${list.length} 条商机${mode==='ledger'?' · 按销售小二分组':' · 按当前推进条件展示'}<span>${S.actor.role==='admin'?'按授权团队范围查看':'仅展示本人有权查看的商机'}</span></div></section>`;
}
function signedSummary(o){
  const actual=o.signed_summary;
  if(!actual)return '<p class="opportunity-muted-note">签约依据待核对，请到合同台账查看。</p>';
  if(actual.count===0&&!isWonStage(o.stage))return '<section class="opportunity-signed-summary opportunity-no-signing"><h3>当前有效签约</h3><p class="opportunity-muted-note">暂无有效关联合同，登记签署后在此查看合同金额与实际到账。</p></section>';
  return `<section class="opportunity-signed-summary"><div class="section-head"><div><h3>当前有效签约</h3><p>按本人有权查看的有效合同实时汇总</p></div><span>${actual.count} 份合同</span></div><div class="opportunity-money-grid">${[['合同金额',actual.amount],['产品金额',actual.product_amount],['项目 / 服务金额',actual.service_amount],['实际到账',actual.collected]].map(([label,value])=>`<div><span>${label}</span><strong>${optionalMoney(value)}</strong></div>`).join('')}</div>${isWonStage(o.stage)&&actual.count===0?'<p class="text-warning">此商机保留历史赢单，当前没有有效签约合同，请核对合同是否已终止、删除或调整关联。</p>':''}</section>`;
}
function opportunityContacts(S,o,contacts){
  return `<section class="detail-section opportunity-key-contacts">${sectionHead('关键联系人','客户已授权的在用联系信息')}<div class="opportunity-contact-list">${contacts.slice(0,4).map(p=>`<article><div><b>${esc(p.name)}</b><small>${esc(p.title||'职位待补充')}</small></div>${badge(p.role||'角色待补充',p.role==='决策人'?'blue':'neutral')}<p>${esc(p.phone||p.wechat&&'微信：'+p.wechat||p.dingtalk&&'钉钉：'+p.dingtalk||'联系方式待补充')}</p><small>最近触达：${esc(p.last_contact?dateLabel(p.last_contact):'尚未登记')}</small></article>`).join('')||'<p class="muted">暂无可见的联系人资料，可到客户档案核对。</p>'}</div><p class="opportunity-muted-note">以上为客户联系资料，本项目的决策与采购角色请结合沟通记录核对。</p></section>`;
}
function advice(S,o){
  if(S.actor.role==='pm')return '';
  if(!S.ai?.configured&&!o.ai_advice)return '<section class="detail-section opportunity-advice-state"><h3>AI 阶段建议</h3><p class="muted">AI 建议暂未启用，可继续记录跟进和维护下一步行动。</p></section>';
  const panel=salesAdvicePanel(S,o);
  const content=S.ai?.configured?panel:panel.replace(/<button\b[^>]*data-action="opportunity-advice"[\s\S]*?<\/button>/g,'');
  return `<details class="opportunity-advice-details"><summary>AI 阶段建议${o.ai_advice?' · 查看已生成内容':''}</summary>${!S.ai?.configured?'<p class="opportunity-muted-note">当前未启用分析，下方保留上次已生成内容供参考。</p>':''}${content}</details>`;
}
export function opportunityDetail(S,id) {
  const o=S.opportunities.find(o=>o.id===Number(id));if(!o)return empty('商机不存在');
  const c=S.customers.find(c=>c.id===o.customer_id),activities=S.activities.filter(a=>a.opportunity_id===o.id),quotes=S.quotes.filter(q=>q.opportunity_id===o.id).sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||''))||b.id-a.id),contracts=S.contracts.filter(c=>c.opportunity_id===o.id),closed=isClosedStage(o.stage),editable=canEdit(S,o);
  const contacts=S.contacts.filter(p=>p.customer_id===o.customer_id&&!p.archived_at).sort((a,b)=>(a.role==='决策人'?-1:0)-(b.role==='决策人'?-1:0));
  const quoteRecords=quotes.map((quote,index)=>quoteRecord(quote,index,S)).join('');
  return `<link rel="stylesheet" href="./modules/opportunities.css"><header class="dialog-head opportunity-detail-head"><div><span class="detail-type">${esc(o.code)} ${stageBadge(o.stage)}</span><h2>${esc(o.name||'待补充产品')}</h2><p>${esc(c?.name||(o.customer_id==null?'待补充客户':'客户'))} · 销售 ${esc(salesName(S,o))}</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="drawer-body opportunity-workspace"><div class="detail-actionbar">${button('记录跟进','new-activity',o.id,'primary','note')}${editable?button('编辑商机','edit-opportunity',o.id,'secondary','edit'):''}${editable&&!isWonStage(o.stage)&&!isLostStage(o.stage)?button('更新阶段','opportunity-stage',o.id,'secondary','arrow'):''}${c?button('客户档案','customer',c.id,'ghost','customers'):''}${!closed&&S.actor.role!=='pm'?button('登记报价','new-quote',o.id,'ghost','contracts'):''}${canManageContractData(S)&&editable&&!isLostStage(o.stage)&&!contracts.length?button('新增合同','convert',o.id,'ghost','contracts'):''}</div>${stageRail(S,o)}<section class="opportunity-estimate"><div class="section-head"><div><h3>${isWonStage(o.stage)?'初始登记预估':'商机预估'}</h3><p>${isWonStage(o.stage)?'总额取初始登记预估，产品拆分沿用登记预估；历史缺项保留待核对。':'产品金额为预计产品销售额，实际到账见下方合同依据。'}</p></div></div><div class="opportunity-money-grid">${[['预计商机金额',forecastAmount(o)],['预计产品金额',forecastProduct(o)],['预计项目 / 服务金额',opportunityServiceAmount(o)]].map(([label,value])=>`<div><span>${label}</span><strong>${optionalMoney(value)}</strong></div>`).join('')}<div><span>预计签约日</span><strong class="opportunity-date-value">${esc(o.expected_date?dateLabel(o.expected_date):'待确认')}</strong></div></div></section>${signedSummary(o)}<dl class="detail-facts opportunity-detail-facts"><div><dt>销售类型</dt><dd>${esc(o.sale_type||'待补充')}</dd></div><div><dt>订单类型</dt><dd>${esc(o.order_type||'待补充')}</dd></div><div><dt>协作PM</dt><dd>${o.collaborator_pm?esc(userName(S,o.collaborator_pm)):'未指定'}</dd></div><div><dt>推进状态</dt><dd>${riskBadge({...o,risk:o.risk||{level:'normal'}})}</dd></div></dl>${riskReasons(o).length?`<section class="opportunity-detail-risks"><h3>当前提醒</h3>${riskSummary(o)}</section>`:''}<div class="next-step-block"><div>${icon('arrow')}<b>${o.stage==='搁置'?'恢复条件 / 复查安排':'下一步行动'}</b><span>${esc(followLabel(S,o))}</span></div><p>${esc(o.next_action||'待安排')}</p></div>${!closed?`<section class="detail-section">${sectionHead('阶段建议')}<p class="prose">${esc(S.rules.sop[o.stage]||'')}</p>${!contacts.some(p=>p.role==='决策人')?'<p class="muted">待核对本项目决策人。</p>':''}</section>`:''}${isLostStage(o.stage)?`<section class="detail-section"><h3>输单原因</h3><p class="prose">${esc(o.lost_reason||'待补充')}</p></section>`:''}${opportunityContacts(S,o,contacts)}${advice(S,o)}${quotes.length?`<section class="detail-section">${sectionHead('报价记录',quotes.length+' 个版本')}${quoteRecords}</section>`:''}<section class="detail-section">${sectionHead('合同依据',contracts.length+' 份可见合同')}${contracts.map(row=>`<button class="linked-record" data-action="contract" data-id="${row.id}"><span><b>${esc(row.name)}</b><small>${optionalMoney(row.amount)} · ${esc(row.sign_date?dateLabel(row.sign_date):'签约日待补充')}</small></span>${badge(row.terminated_at?'已终止':contractStatusLabel(row.lifecycle))}${icon('chevron')}</button>`).join('')||'<p class="muted">暂无可见的关联合同。</p>'}</section><section class="detail-section">${sectionHead('跟进时间线')}${timeline(S,activities,false,o.id)}</section>${S.actor.role!=='pm'?linkedMinutes('opportunity',o.id):''}</div>`;
}

const preserveOptions=(values,current)=>[...new Set([...values,...(current?[current]:[])])];
export function formOpportunities(S,type,id,options={}) {
  const customerOptions=options.customerOptions||[];
  if(type==='opportunity-stage'){
    const o=S.opportunities.find(o=>o.id===Number(id));if(!o)return empty('商机不存在');if(!canEdit(S,o))return empty('当前账号无权维护此商机');
    if(isWonStage(o.stage)||isLostStage(o.stage))return empty('已结束商机保留历史阶段','赢单由已签署合同登记自动产生；输单记录可在资料编辑中补充原因。');
    const stages=S.stages.filter(s=>!isWonStage(s)),flow=['线索','需求','方案','商务'],at=flow.indexOf(o.stage),initial=at>=0&&at<flow.length-1?flow[at+1]:o.stage;
    return formShell('更新商机阶段',customerLabel(S,o)+' · '+(o.name||'商机'),`<div class="wide opportunity-stage-context">当前阶段 ${stageBadge(o.stage)}<p>按本次已确认进展调整；跨阶段、回退或搁置请说明依据。赢单会在新增已签署合同后自动更新。</p></div>`+select('stage','调整到',[['','请选择调整后的阶段'],...stages],stages.includes(initial)?initial:'','required')+textarea('reason','本次进展 / 调整原因','')+'<p class="wide opportunity-field-note" data-stage-reason-hint>可补充阶段调整依据，便于复盘。</p>'+`<div class="wide opportunity-lost-reason" data-stage-lost hidden>${textarea('lost_reason','输单原因','')}</div>`+textarea('next_action','下一步动作 / 恢复条件',o.next_action||'')+input('follow_date','下次跟进 / 复查日期',o.follow_date||'','date',false),type,id,'保存阶段');
  }
  if(type!=='opportunity'&&type!=='edit-opportunity')return;
  const editing=type==='edit-opportunity',o=editing?S.opportunities.find(o=>o.id===Number(id)):null;
  if(editing&&(!o||!canEdit(S,o)))return empty(o?'当前账号无权维护此商机':'商机不存在');
  if(!editing&&!customerOptions.length)return empty('请先新建客户','',button('新建客户','new-customer','','primary','plus'));
  const fields=(editing?`<div class="wide opportunity-form-context"><b>${esc(customerLabel(S,o))}</b><span>销售：${esc(salesName(S,o))} · 当前${esc(o.stage)}</span></div>`:select('customer_id','关联客户',[['','请选择客户'],...customerOptions],id||'','required'))+
    input('name','售卖产品',o?.name||'')+(!editing?(S.actor.role==='admin'?select('owner_id','销售',S.users.filter(u=>u.active&&u.role!=='pm').map(u=>[u.id,u.name]),S.actor.id):`<input type="hidden" name="owner_id" value="${S.actor.id}"><p class="wide form-context">销售：${esc(S.actor.name)}</p>`):'')+
    (editing?(S.actor.role==='admin'?select('collaborator_pm','协作PM',[['','未指定'],...S.users.filter(u=>u.role==='pm'&&(u.active||u.id===o.collaborator_pm)).map(u=>[u.id,u.name+(u.active?'':'（已停用）')])],o.collaborator_pm||'',false):''):select('collaborator_pm','协作PM',[['','未指定'],...S.users.filter(u=>u.active&&u.role==='pm').map(u=>[u.id,u.name])],'',false))+
    input('amount','预计商机金额（元）',editing&&knownAmount(forecastAmount(o))?Number(forecastAmount(o))/100:'','number',!editing,'min="0" step="0.01"'+(editing&&isWonStage(o.stage)?' disabled':''))+input('product_amount','预计产品金额（元）',editing&&knownAmount(forecastProduct(o))?Number(forecastProduct(o))/100:'','number',!editing,'min="0" step="0.01" placeholder="无产品时明确填 0"'+(editing&&isWonStage(o.stage)?' disabled':''))+
    (editing&&isWonStage(o.stage)?'<p class="wide opportunity-field-note">原始预估保留；签约金额及产品拆分由合同台账实时提供。</p>':'')+
    select('sale_type','销售类型',[['','请选择'],...preserveOptions(salesTypes,o?.sale_type)],o?.sale_type||'',editing?'':'required')+select('order_type','订单类型',[['','请选择'],...preserveOptions(orderTypes,o?.order_type)],o?.order_type||'',editing?'':'required')+
    (!editing?select('stage','销售阶段',S.stages.filter(s=>!isWonStage(s)&&!isLostStage(s)),'线索'):'')+input('expected_date','预计签约日',o?.expected_date||'','date',false)+textarea('next_action','下一步动作',o?.next_action||'')+input('follow_date','下次跟进日期',o?.follow_date||'','date',false)+(editing&&isLostStage(o.stage)?textarea('lost_reason','输单原因',o.lost_reason||'',true):'');
  return formShell(editing?'编辑商机资料':'新建商机',editing?'资料修正保持客户、销售归属及阶段不变。':'先登记已知信息，再通过跟进与阶段更新持续推进。',fields,type,id,editing?'保存商机资料':'创建商机');
}
