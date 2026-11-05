import {linkedMinutes} from './minutes.js';
import {salesAdvicePanel} from './sales-advice-ui.js';
import {esc,icon,plainMoney,dateLabel,shortDate,userName,salesName,avatar,badge,stageBadge,stageRail,riskBadge,actionButton as button,sectionHead,empty,select,input,textarea,formShell,isClosedStage,isWonStage,isLostStage} from '../ui.js';
import {sum,filtered,filters,timeline,needsFollowup} from './shared.js';

const salesTypes=['新签自建','新签分发','续费','增购'];
const orderTypes=['代销','经销','千帆'];
const optionalMoney=value=>value===null||value===undefined?'未提供':plainMoney(value);
const listStages=['赢单','商务','方案','需求','线索','输单','搁置'];
const listSortFields=new Set(['amount','product_amount','service_amount','created_at']);
const knownAmount=value=>(typeof value==='number'||typeof value==='string'&&value.trim()!=='')&&Number.isFinite(Number(value));
const stageRank=stage=>listStages.includes(stage)?listStages.indexOf(stage):listStages.length;
const createdTimestamp=value=>value&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const listMoney=value=>knownAmount(value)?plainMoney(value):'未提供';

// Amounts in state are integer cents. Preserve missing historical values instead of assuming zero.
export const opportunityServiceAmount=o=>knownAmount(o.amount)&&knownAmount(o.product_amount)?Number(o.amount)-Number(o.product_amount):null;

function compareOptional(a,b,desc=false) {
  if(a==null||b==null)return (a==null?1:0)-(b==null?1:0);
  return (a-b)*(desc?-1:1);
}
function sortValue(o,field) {
  if(field==='created_at')return createdTimestamp(o.created_at);
  if(field==='service_amount')return opportunityServiceAmount(o);
  return knownAmount(o[field])?Number(o[field]):null;
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
  return `<div class="table-scroll opportunity-list-scroll" tabindex="0" role="region" aria-label="商机总表，可横向滚动"><table class="data-table opportunity-list-table"><thead><tr><th scope="col">客户名称</th><th scope="col">售卖产品</th><th scope="col">商机阶段</th>${sortHeading('合同金额','amount',P)}${sortHeading('cash金额','product_amount',P)}${sortHeading('项目 / 服务金额','service_amount',P)}<th scope="col">销售小二</th><th scope="col">订单类型</th>${sortHeading('创建时间','created_at',P)}</tr></thead>${groups.map(group=>`<tbody data-owner-id="${esc(group.owner_id??'')}"><tr class="opportunity-group-heading"><th scope="rowgroup" colspan="9"><div>${avatar(group.name,true)}<span>${esc(group.name)}</span><span class="opportunity-group-count">${group.rows.length} 条商机</span></div></th></tr>${group.rows.map(o=>{
    const customer=S.customers.find(c=>c.id===Number(o.customer_id)),customerLabel=customer?.name||customer?.short_name||(o.customer_id==null?'待补充客户':'客户');
    return `<tr class="record-row" tabindex="0" data-action="opportunity" data-id="${esc(o.id)}" aria-label="查看${esc(customerLabel)}的${esc(o.name||'未提供产品')}商机"><td class="opportunity-customer"><span class="record-title company-title">${esc(customerLabel)}</span></td><td class="opportunity-product">${esc(o.name||'未提供')}</td><td>${stageBadge(o.stage||'未提供')}</td><td class="number strong">${listMoney(o.amount)}</td><td class="number">${listMoney(o.product_amount)}</td><td class="number">${listMoney(opportunityServiceAmount(o))}</td><td>${esc(group.name)}</td><td>${esc(o.order_type||'未提供')}</td><td class="opportunity-created">${esc(createdLabel(o.created_at))}</td></tr>`;
  }).join('')}</tbody>`).join('')}</table></div>`;
}
export function opportunities(S,P) {
  const listFilters={...P,owner:'',sort:''};
  const scoped=filtered(S,{...listFilters,risk:''},S.opportunities),list=filtered(S,listFilters,S.opportunities),active=scoped.filter(o=>!isClosedStage(o.stage));
  return `<link rel="stylesheet" href="./modules/opportunities.css">${P.customerLevel||P.saleType||P.from||P.to?`<p class="form-context">沿用看板筛选：${esc([P.customerLevel&&"客户"+P.customerLevel+"级",P.saleType,(P.from||P.to)&&`${P.from||"最早记录"} 至 ${P.to||"最新记录"}创建的商机`].filter(Boolean).join(" · "))}。可点击重置筛选查看全部。</p>`:""}<div class="list-summary"><div class="segment"><button data-action="risk-filter" data-id="" class="${!P.risk?'selected':''}">全部商机 <b>${scoped.length}</b></button><button data-action="risk-filter" data-id="active" class="${P.risk==='active'?'selected':''}">进行中 <b>${active.length}</b></button><button data-action="risk-filter" data-id="won" class="${P.risk==='won'?'selected':''}">赢单 <b>${scoped.filter(o=>isWonStage(o.stage)).length}</b></button><button data-action="risk-filter" data-id="today" class="${P.risk==='today'?'selected':''}">待跟进 <b>${active.filter(o=>needsFollowup(o,S.today)).length}</b></button><button data-action="risk-filter" data-id="risk" class="${P.risk==='risk'?'selected':''}">风险商机 <b>${active.filter(o=>o.risk?.level&&o.risk.level!=='normal').length}</b></button></div><span>合同总额 <b>${plainMoney(sum(list,o=>o.amount||0))}</b></span></div><section class="panel opportunity-list-panel">${filters(S,P,'opportunities')}${opportunityListTable(S,list,P)}<div class="table-footer">共 ${list.length} 条商机 · 按销售小二分组</div></section>`;
}
export function opportunityDetail(S,id) {
  const o=S.opportunities.find(o=>o.id===Number(id));if(!o)return empty('商机不存在');
  const c=S.customers.find(c=>c.id===o.customer_id),a=S.activities.filter(a=>a.opportunity_id===o.id),quotes=S.quotes.filter(q=>q.opportunity_id===o.id),contracts=S.contracts.filter(c=>c.opportunity_id===o.id),closed=isClosedStage(o.stage);
  const contacts=S.contacts.filter(p=>p.customer_id===o.customer_id&&!p.archived_at);
  return `<header class="dialog-head"><div><span class="detail-type">${esc(o.code)} ${stageBadge(o.stage)}</span><h2>${esc(o.name||'待补充产品')}</h2><p>${esc(c?.name||(o.customer_id==null?'待补充客户':'客户'))} · 销售 ${esc(salesName(S,o))}</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="drawer-body">${stageRail(S,o)}<div class="detail-metrics"><div><span>合同总额</span><b>${optionalMoney(o.amount)}</b></div><div><span>cash金额</span><b>${optionalMoney(o.product_amount)}</b></div><div><span>预计到单日</span><b>${dateLabel(o.expected_date)}</b></div></div><dl class="detail-facts"><div><dt>销售类型</dt><dd>${esc(o.sale_type||'待补充')}</dd></div><div><dt>订单类型</dt><dd>${esc(o.order_type||'待补充')}</dd></div><div><dt>协作PM</dt><dd>${o.collaborator_pm?esc(userName(S,o.collaborator_pm)):'未指定'}</dd></div><div><dt>推进状态</dt><dd>${riskBadge(o)}</dd></div></dl><div class="detail-actionbar">${button('记录跟进','new-activity',o.id,'primary','note')}${!closed&&S.actor.role!=='pm'?button('登记报价','new-quote',o.id,'secondary','contracts'):''}${S.actor.role==='admin'&&!isLostStage(o.stage)&&!contracts.length?button('起草合同','convert',o.id,'secondary','contracts'):''}${contracts.length===1?button('查看合同订单','contract',contracts[0].id,'secondary','contracts'):''}</div><div class="next-step-block"><div>${icon('arrow')}<b>下一步行动</b><span>${o.follow_date===S.today?'今天':shortDate(o.follow_date)}</span></div><p>${esc(o.next_action||'待安排')}</p></div>${!closed?`<section class="detail-section">${sectionHead('阶段建议')}<p class="prose">${esc(S.rules.sop[o.stage]||'')}</p>${o.risk.overdue?`<p class="text-warning">已超过跟进日期 ${o.risk.overdue} 天</p>`:''}${!contacts.some(p=>p.role==='决策人')?'<p class="muted">待补充决策人。</p>':''}</section>`:''}${salesAdvicePanel(S,o)}${isLostStage(o.stage)?`<p class="prose">输单原因：${esc(o.lost_reason||'待补充')}</p>`:''}${quotes.length?`<section class="detail-section">${sectionHead('报价记录')}<div class="quote-records">${quotes.map(q=>`<article class="quote-record"><div class="quote-line"><span><b>${esc(q.code)}</b><small>有效期至 ${dateLabel(q.valid_until)}</small></span><b>${plainMoney(q.amount)}</b>${button('导出Word','download-quote',q.id,'ghost','download')}</div>${q.items?.length?`<details><summary>${q.items.length} 项报价明细</summary><div class="table-scroll"><table class="data-table detail-table"><thead><tr><th>内容</th><th>数量</th><th>原价单价</th><th>折扣</th><th>小计</th></tr></thead><tbody>${q.items.map(i=>`<tr><td>${esc(i.name)}</td><td>${esc(i.quantity)}</td><td>${plainMoney(i.list_price)}</td><td>${Math.round(i.discount_rate*10000)/100}%</td><td>${plainMoney(i.amount)}</td></tr>`).join('')}</tbody></table></div></details>`:''}</article>`).join('')}</div></section>`:''}${contracts.length>1?`<section class="detail-section">${sectionHead('合同订单')}${contracts.map(c=>`<button class="linked-record" data-action="contract" data-id="${c.id}"><span><b>${esc(c.name)}</b><small>${plainMoney(c.amount)}</small></span>${badge(c.lifecycle||'历史登记')}${icon('chevron')}</button>`).join('')}</section>`:''}<section class="detail-section">${sectionHead('跟进时间线')}${timeline(S,a,false,o.id)}</section>${S.actor.role!=='pm'?linkedMinutes('opportunity',o.id):''}</div>`;
}
export function formOpportunities(S,type,id,options) {
  if(type!=='opportunity')return;
  const {customerOptions}=options;if(!customerOptions.length)return empty('请先新建客户','',button('新建客户','new-customer','','primary','plus'));
  return formShell('新建商机','',select('customer_id','关联客户',customerOptions,id||customerOptions[0][0])+
    input('name','售卖产品')+(S.actor.role==='admin'?select('owner_id','销售',S.users.filter(u=>u.active&&u.role!=='pm').map(u=>[u.id,u.name]),S.actor.id):`<input type="hidden" name="owner_id" value="${S.actor.id}"><p class="wide form-context">销售：${esc(S.actor.name)}</p>`)+
    select('collaborator_pm','协作PM',[['','未指定'],...S.users.filter(u=>u.active&&u.role==='pm').map(u=>[u.id,u.name])],'',false)+
    input('amount','合同总额（元）','','number',true,'min="0" step="0.01"')+input('product_amount','cash金额（元）','','number',true,'min="0" step="0.01" placeholder="可明确填 0"')+
    select('sale_type','销售类型',[['','请选择'],...salesTypes],'','required')+select('order_type','订单类型',[['','请选择'],...orderTypes],'','required')+
    select('stage','销售阶段',S.stages.filter(s=>!isWonStage(s)&&!isLostStage(s)),'线索')+input('expected_date','预计到单日','','date',false)+
    textarea('next_action','下一步动作','',false)+input('follow_date','下次跟进日期','','date',false),type,id,'创建商机');
}
