import {monthlyBoard} from './monthly-board.js';
import {linkedMinutes} from './minutes.js';
import {contractStatusLabel} from './contract-status.js';
import {
  esc, icon, plainMoney, salesName, avatar, badge, stageBadge,
  actionButton as button, sectionHead, empty, select, input, textarea,
  formShell, isClosedStage,
} from '../ui.js';
import {selectCustomers, filters, timeline} from './shared.js';

const knownMoney=value=>typeof value==='number'&&Number.isFinite(value);
const amountText=value=>knownMoney(value)?plainMoney(value):'待核对';
const profileTime=value=>String(value).replace('T',' ').replace(/(?:\.\d+)?Z$/,' UTC');
const profileCount=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const managedStatus=c=>c.management_status||(['冻结','流失'].includes(c.status)?c.status:'正常');
const relationship=c=>c.relationship_status||'待核对';
const managementBadge=c=>badge(managedStatus(c),managedStatus(c)==='冻结'?'warning':managedStatus(c)==='流失'?'neutral':'success');
const relationshipBadge=c=>badge(relationship(c),relationship(c)==='已合作'?'success':'blue');
const canEdit=(S,c)=>S.actor.role==='admin'||S.actor.role==='sales'&&!c.shared&&Number(c.owner_id)===Number(S.actor.id);
const activeContract=c=>!c.retired_at&&!c.terminated_at&&c.lifecycle!=='草稿';
const activeContacts=(S,c)=>S.contacts.filter(p=>p.customer_id===c.id&&!p.archived_at).sort((a,b)=>(a.role==='决策人'?-1:0)-(b.role==='决策人'?-1:0)||a.id-b.id);
const sumKnown=(rows,key)=>rows.every(row=>knownMoney(row[key]))?rows.reduce((sum,row)=>sum+row[key],0):null;

export function companyProfileDetails(c,canRefresh=false) {
  if(c.shared)return '';
  const p=c.company_profile||{state:'not_read',details:{}},d=p.details||{},job=p.job||{};
  const status=p.state==='not_configured'?'not_configured':p.state==='stale'&&['complete','ready'].includes(job.status)?'stale':job.status||p.state;
  const manualMode=job.manual_only===true||job.error_code==='MANUAL_REQUIRED';
  const busy=status==='running'||!manualMode&&['pending','queued'].includes(status);
  const refresh=canRefresh&&p.can_refresh!==false&&status!=='not_configured'
    ?busy?'<button class="btn ghost" disabled aria-disabled="true">手动查询</button>':button('手动查询','refresh-company-profile',c.id,'ghost','refresh'):'';
  const fields=[['company_name','企业名称'],['credit_code','统一社会信用代码'],['company_description','企业简介'],['company_scale','企业规模'],['employee_scale','人员规模'],['insured_count','参保人数'],['main_business','主营业务'],['main_products','主营产品'],['business_scope','工商经营范围'],['annual_employees','年报从业人数'],['annual_report_year','年报年度'],['industry',['qwen','deepseek'].includes(d._lookup?.field_sources?.industry)?'行业':'企查查行业'],['national_industry','国标行业'],['registered_capital','注册资本'],['registration_status','登记状态'],['established_at','成立时间'],['registered_address','注册地址'],['source_updated_at','来源更新时间']];
  const provided=value=>value!==null&&value!==undefined&&value!=='';
  const fieldValue=value=>provided(value)?Array.isArray(value)?value.join('；'):String(value):'源接口未提供';
  const fact=([key,label])=>`<div${['business_scope','company_description','main_products'].includes(key)?' class="wide"':''}><dt>${label}</dt><dd>${esc(fieldValue(d[key]))}${['qwen','deepseek'].includes(d._lookup?.field_sources?.[key])?'<small class="muted"> · AI 整理，待核验</small>':''}</dd></div>`;
  const sources=(Array.isArray(d._lookup?.sources)?d._lookup.sources:[]).filter(s=>{try{const u=new URL(s.url);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}).slice(0,8);
  const references=sources.length?`<p class="company-profile-meta">查询依据：${sources.map(s=>`<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title||'公开资料')}</a>`).join(' · ')}</p>`:'';
  const hasFacts=fields.some(([key])=>provided(d[key]));
  const core=fields.filter(([key])=>['company_name','company_scale','main_business','registration_status'].includes(key)&&provided(d[key]));
  return `<section class="company-profile" aria-busy="${busy}">${sectionHead('企业详细信息','',refresh)}${status==='not_configured'?'<p class="muted">企业资料未接入，可先手动维护客户档案。</p>':''}${p.checked_at?`<p class="company-profile-meta">读取时间：${esc(profileTime(p.checked_at))}</p>`:''}${hasFacts?`${core.length?`<dl class="detail-facts customer-profile-core">${core.map(fact).join('')}</dl>`:''}<details class="customer-profile-more"><summary>查看完整企业资料</summary><dl class="detail-facts">${fields.map(fact).join('')}</dl>${references}<p class="muted">工商经营范围不等于实际主营业务，参保人数不等于全部员工人数。</p></details>`:''}</section>`;
}

export function companyProfileFeedback(p={}){
  if(['pending','queued','running'].includes(p.job?.status))return {pending:true,message:'正在查询企业资料，完成后会自动更新',error:false};
  if(['qwen','deepseek'].includes(p.details?._lookup?.kind))return {pending:false,message:p.reason||'已转 AI 查询，结果已更新',error:!Object.keys(p.details).some(k=>k!=='_lookup'&&p.details[k]!==null&&p.details[k]!=='')};
  if(p.state==='ready')return {pending:false,message:'企业资料已更新',error:false};
  return {pending:false,message:p.reason||'本次未取得企业资料，请稍后重试',error:true};
}

export function companyProfileProgress(S) {
  const p=S.company_profiles;
  if(S.actor?.role!=='admin'||!p)return '';
  const counts=p.counts||{},total=profileCount(counts.total),busy=profileCount(counts.running)>0;
  const action=p.configured&&total>0?(busy?'<button class="btn ghost" disabled aria-disabled="true">手动查询</button>':button('手动查询','query-all-company-profiles','','ghost','refresh')):'';
  return action?`<div class="company-profile-progress">${action}</div>`:'';
}

export function customerPrimaryContact(S,c){
  if(c.shared)return '<span class="muted">联系信息按权限可见</span>';
  const contacts=activeContacts(S,c),p=contacts[0];
  return p?`<span class="customer-contact"><b>${esc(p.name)}</b><small>${esc(p.phone||p.title||p.wechat&&'微信已登记'||p.dingtalk&&'钉钉已登记'||'联系方式待补充')}${contacts.length>1?' · 另 '+(contacts.length-1)+' 人':''}</small></span>`:'<span class="muted">待添加联系人</span>';
}

export function customers(S,P={}) {
  const scope=P.customerScope|| (S.actor.role==='sales'?'mine':'all');
  const list=selectCustomers(S,P),counts={all:S.customers.length,mine:S.customers.filter(c=>Number(c.owner_id)===Number(S.actor.id)).length,shared:S.customers.filter(c=>c.shared).length};
  const tabs=S.actor.role==='sales'?[['mine','我的客户'],['shared','团队共享']]:S.actor.role==='admin'?[['all','全部客户'],['mine','我的客户']]:[['all','关联客户']];
  const title=tabs.find(([id])=>id===scope)?.[1]||'客户档案';
  return `${monthlyBoard(S,P,'customer')}<div class="list-summary customer-list-summary"><span>${esc(title)} <b>${list.length}</b></span><span>${S.actor.role==='sales'?'本人联系信息可直接维护，团队主档按权限共享':'客户主档团队共享，联系信息按归属可见'}</span>${companyProfileProgress(S)}</div><section class="panel customer-list-panel"><nav class="customer-scope-tabs" aria-label="客户范围">${tabs.map(([id,label])=>`<button type="button" data-action="customer-scope" data-id="${id}" aria-pressed="${scope===id}" class="${scope===id?'active':''}">${label}<span>${counts[id]}</span></button>`).join('')}</nav>${filters(S,P,'customers')}${list.length?`<div class="table-scroll customer-desktop-table"><table class="data-table"><thead><tr><th>客户名称</th><th>主要联系人</th><th>行业 / 地区</th><th>客户等级</th><th>负责人</th><th>合作 / 管理状态</th><th>最近沟通</th></tr></thead><tbody>${list.map(c=>`<tr class="record-row" tabindex="0" data-action="customer" data-id="${c.id}" aria-label="查看${esc(c.name)}的客户档案"><td><div class="company-cell"><span class="company-symbol">${esc((c.short_name||c.name).slice(0,1))}</span><div><span class="record-title">${esc(c.name)}</span><span class="record-meta">${esc(c.short_name||'未设置简称')}${c.shared?' · 共享主档':''}</span></div></div></td><td>${customerPrimaryContact(S,c)}</td><td>${esc(c.industry||'待补充')}<span class="record-meta">${esc(c.region||'地区待补充')}</span></td><td>${canEdit(S,c)?`<button class="text-link" data-action="customer-level" data-id="${c.id}">${esc(c.manual_level||'未标注')}</button>`:badge(c.manual_level||'未标注','blue')}</td><td><span class="owner-cell">${avatar(salesName(S,c),true)}${esc(salesName(S,c))}</span></td><td><span class="customer-state-pair">${relationshipBadge(c)}${managementBadge(c)}</span></td><td>${c.shared?'<span class="muted">按权限可见</span>':esc(c.last_interaction||'尚无沟通记录')}<span class="record-meta">${c.shared?'':S.opportunities.filter(o=>o.customer_id===c.id&&!isClosedStage(o.stage)).length+' 个进行中商机'}</span></td></tr>`).join('')}</tbody></table></div><div class="customer-mobile-list">${list.map(c=>`<button type="button" class="customer-mobile-card" data-action="customer" data-id="${c.id}" aria-label="查看${esc(c.name)}的客户档案"><span class="customer-mobile-title"><strong>${esc(c.name)}</strong>${icon('chevron')}</span><span class="customer-mobile-meta">${esc(c.short_name||c.industry||'资料待补充')} · ${esc(c.region||'地区待补充')}</span><span class="customer-mobile-states">${badge(c.manual_level||'未标注','blue')}${relationshipBadge(c)}${managementBadge(c)}</span><span class="customer-mobile-owner">负责人：${esc(salesName(S,c))}${c.shared?' · 共享主档':''}</span><span class="customer-mobile-contact">${customerPrimaryContact(S,c)}</span>${!c.shared?`<span class="customer-mobile-follow">最近沟通：${esc(c.last_interaction||'尚未登记')}</span>`:''}</button>`).join('')}</div>`:empty('没有匹配的客户',scope==='mine'?'可新建客户，或切换团队共享查找已有主档。':'试试调整搜索词或筛选条件。')}<div class="table-footer">当前 ${list.length} 位客户<span>联系信息与业务数据按权限展示</span></div></section>`;
}

export function customerBusinessTotals(c,contracts){
  const visible=contracts.filter(row=>row.customer_id===c.id);
  if(c.shared&&!visible.length)return null;
  const effective=visible.filter(activeContract);
  const outstanding=effective.map(row=>({...row,open_amount:knownMoney(row.outstanding)?Math.max(0,row.outstanding):null}));
  return {count:effective.length,amount:sumKnown(effective,'amount'),collected:sumKnown(effective,'collected'),outstanding:sumKnown(outstanding,'open_amount')};
}
function businessSummary(S,c,contracts){
  const totals=customerBusinessTotals(c,contracts);
  if(!totals)return '<p class="customer-permission-note">当前为共享主档，联系人与业务金额按归属权限查看。</p>';
  const stats=[['有效合同',String(totals.count),'当前未终止的已签署及历史登记合同'],['合同金额',amountText(totals.amount),'仅统计当前可见合同'],['实际到账',amountText(totals.collected),'按真实到账记录汇总'],['待回款',amountText(totals.outstanding),'按各合同未收金额合计']];
  return `${c.shared?'<p class="customer-permission-note">客户主档已共享；下列仅展示本人有权查看的合同，联系人仍按客户归属查看。</p>':''}<section class="customer-business-summary" aria-label="客户业务概览">${stats.map(([label,value,note])=>`<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('')}</section><p class="customer-overview-note">${S.actor.role==='admin'?'汇总该客户当前可见的有效合同。':'仅汇总本人有权查看的有效合同。'}草稿及已终止合同在业务往来中单独标注。</p>`;
}

function contactMethod(name,label,value){
  if(!value)return '';
  const number=String(value).replace(/[^\d+*#]/g,'');
  return `<span class="customer-contact-method"><span>${label}：${name==='phone'&&number?`<a href="tel:${esc(number)}">${esc(value)}</a>`:esc(value)}</span><button type="button" class="text-link" data-action="copy-contact" data-value="${esc(value)}" aria-label="复制${label}">复制</button></span>`;
}
function contactCard(p,editable){
  return `<article class="customer-contact-card${p.archived_at?' is-archived':''}" data-contact-id="${p.id}"><header>${avatar(p.name,true)}<div><h4>${esc(p.name)}${p.title?`<small>${esc(p.title)}</small>`:''}</h4><span>${badge(p.role||'角色待补充',p.role==='决策人'?'blue':'neutral')}${badge(p.attitude||'态度待补充',p.attitude==='支持'?'success':'neutral')}${p.archived_at?badge('已停用'):''}</span></div>${editable?button('编辑','edit-contact',p.id,'ghost','edit'):''}</header><div class="customer-contact-methods">${contactMethod('phone','电话',p.phone)}${contactMethod('wechat','微信',p.wechat)}${contactMethod('dingtalk','钉钉',p.dingtalk)}${!p.phone&&!p.wechat&&!p.dingtalk?'<p class="muted">联系方式待补充</p>':''}</div><p class="customer-contact-touch">最近触达：${esc(p.last_contact||'尚未登记')}</p>${p.note?`<p class="customer-contact-note">${esc(p.note)}</p>`:''}</article>`;
}
const section=(id,title,sub,content,open=true)=>`<details class="customer-detail-group" data-customer-section="${id}" ${open?'open':''}><summary><span>${title}</span>${sub?`<small>${sub}</small>`:''}</summary><div class="customer-group-body">${content}</div></details>`;

export function customerDetail(S,id) {
  const c=S.customers.find(c=>c.id===Number(id));
  if(!c)return empty('客户不存在');
  const editable=canEdit(S,c),contacts=S.contacts.filter(x=>x.customer_id===c.id),active=activeContacts(S,c),archived=contacts.filter(p=>p.archived_at),opps=S.opportunities.filter(o=>o.customer_id===c.id),contracts=S.contracts.filter(x=>x.customer_id===c.id);
  const activities=S.activities.filter(a=>opps.some(o=>o.id===a.opportunity_id));
  const tags=String(c.tags||'').split(/[,，、;；\n]/).map(x=>x.trim()).filter(Boolean);
  const facts=[['负责人',salesName(S,c)],['合作情况',relationship(c)],['管理状态',managedStatus(c)],['行业 / 地区',[c.industry,c.region].filter(Boolean).join(' · ')||'待补充'],['母公司',c.parent_company||'未填写'],['所属集团',c.group_name||'未填写'],...(!c.shared?[['客户规模',c.scale||'待补充'],['信用代码',c.credit_code||'待补充']]:[])];
  const overview=`${businessSummary(S,c,contracts)}${c.compliance_flag?`<div class="customer-risk-note">${icon('alert')}<div><b>流程 / 风险提示</b><p>${esc(c.compliance_flag)}</p></div></div>`:''}${tags.length?`<div class="customer-tags" aria-label="企业标签">${tags.map(tag=>badge(tag)).join('')}</div>`:''}${managedStatus(c)==='冻结'?'<p class="customer-status-note">冻结为客户管理标记，仍可补录历史资料及登记业务；签约不会自动清除该标记。</p>':''}<dl class="detail-facts customer-basic-facts">${facts.map(([label,value])=>`<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${!c.shared?`<div class="customer-note-block"><h3>客户备注</h3><p>${esc(c.note||'暂无备注')}</p></div>`:''}`;
  const contactContent=`<div class="customer-section-actions">${S.actor.role!=='pm'?button('添加联系人','new-contact',c.id,'secondary','plus'):''}<span>决策人优先展示，停用联系人保留历史。</span></div><div class="customer-contact-grid">${active.map(p=>contactCard(p,editable)).join('')||'<p class="customer-empty">暂无在用联系人，可先登记电话、微信或钉钉。</p>'}</div>${archived.length?`<details class="customer-archived-contacts"><summary>已停用联系人（${archived.length}）</summary><div class="customer-contact-grid">${archived.map(p=>contactCard(p,editable)).join('')}</div></details>`:''}`;
  const business=`<div class="customer-business-head"><h3>关联合同 <span>${contracts.length}</span></h3></div>${contracts.map(row=>`<article class="customer-contract-record"><header><div><button class="text-link customer-contract-title" data-action="contract" data-id="${row.id}">${esc(row.name||row.code||'未命名合同')}</button><small>${esc(row.contract_no||row.code||'编号待补充')} · ${esc(row.sign_date||'签约日期待补充')}</small></div>${badge(row.terminated_at?'已终止':contractStatusLabel(row.lifecycle),row.terminated_at||row.lifecycle==='草稿'?'neutral':'blue')}</header><dl><div><dt>合同金额</dt><dd>${amountText(row.amount)}</dd></div><div><dt>实际到账</dt><dd>${amountText(row.collected)}</dd></div><div><dt>待回款</dt><dd>${knownMoney(row.outstanding)?plainMoney(Math.max(0,row.outstanding)):'待核对'}</dd></div></dl><footer>${button('查看合同','contract',row.id,'ghost','contracts')}${button('查看回款','contract-collections',row.id,'secondary','wallet')}</footer></article>`).join('')||'<p class="customer-empty">暂无可见的关联合同。</p>'}<div class="customer-business-head"><h3>关联商机 <span>${opps.length}</span></h3>${editable?button('新建商机','new-opportunity',c.id,'ghost','plus'):''}</div>${opps.map(o=>`<button class="linked-record" data-action="opportunity" data-id="${o.id}"><span><b>${esc(o.name)}</b><small>${amountText(o.amount)} · ${esc(o.next_action||'下一步待补充')}</small></span>${stageBadge(o.stage)}${icon('chevron')}</button>`).join('')||'<p class="customer-empty">暂无可见的关联商机。</p>'}`;
  const communication=`${activities.length?timeline(S,activities.slice(0,12),true):'<p class="customer-empty">尚无关联商机的沟通记录。</p>'}${activities.length>12?`<details class="customer-more-activities"><summary>查看更早记录（${activities.length-12} 条）</summary>${timeline(S,activities.slice(12),true)}</details>`:''}${S.actor.role!=='pm'?linkedMinutes('customer',c.id):''}`;
  return `<header class="dialog-head customer-detail-head"><div><span class="detail-type">客户档案 ${badge(c.manual_level||'未标注','blue')}${c.shared?badge('共享主档'):''}</span><h2>${esc(c.name)}</h2><p>${esc(c.short_name||c.industry||'行业待补充')}${c.region?' · '+esc(c.region):''}</p></div><button class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="drawer-body customer-workspace"><div class="detail-actionbar">${editable?button('编辑客户资料','edit-customer',c.id,'secondary','edit')+button('新建商机','new-opportunity',c.id,'primary','plus')+button('添加联系人','new-contact',c.id,'ghost','plus'):badge('共享主档 · 联系信息按归属可见')}${S.actor.role==='admin'?button('转交客户','customer-transfer',c.id,'ghost','team'):''}</div>${section('overview','客户概览','客户信息与业务总览',overview)}${!c.shared?section('contacts','联系人与决策链',`${active.length} 位在用${archived.length?' · '+archived.length+' 位停用':''}`,contactContent):''}${section('business',c.shared?'本人可见业务':'业务往来',`${contracts.length} 份可见合同 · ${opps.length} 个可见商机`,business)}${!c.shared?section('communication','沟通记录',`${activities.length} 条可见记录`,communication,false)+section('company','企业资料','外部资料独立展示',companyProfileDetails(c,editable),false):''}</div>`;
}

function ownerField(S,c,editing=false){
  const options=S.users.filter(u=>u.active&&u.role!=='pm').map(u=>[u.id,u.name]);
  if(editing&&c.owner_id==null)options.unshift(['','原始资料未提供']);
  else if(editing&&!options.some(([id])=>Number(id)===Number(c.owner_id))){const u=S.users.find(u=>Number(u.id)===Number(c.owner_id));options.unshift([c.owner_id,(u?.name||'原负责人')+(u?.active?'':'（已停用）')]);}
  return select('owner_id',editing?'当前负责人':'负责人',options,editing?c.owner_id??'':S.actor.id,editing?'disabled':'required');
}

export function formCustomers(S,type,id,options={}) {
  if(type==='customer-level'){
    const c=S.customers.find(c=>c.id===Number(id));if(!c)return empty('客户不存在');
    if(!canEdit(S,c))return empty('当前账号无权维护该客户');
    return formShell('标注客户等级',c.name,select('manual_level','客户等级',[['','未标注'],...[...new Set([...(S.rules.customer_levels||[]),...(c.manual_level?[c.manual_level]:[])])].map(v=>[v,v])],c.manual_level||''),type,id,'保存等级');
  }
  if(type==='customer-transfer'){
    const c=S.customers.find(c=>c.id===Number(id));if(!c)return empty('客户不存在');
    if(S.actor.role!=='admin')return empty('仅管理员可以转交客户');
    const owners=S.users.filter(u=>u.active&&u.role!=='pm'&&Number(u.id)!==Number(c.owner_id)).map(u=>[u.id,u.name]);
    return formShell('转交客户',c.name,`<div class="wide customer-transfer-context"><span>当前负责人</span><strong>${esc(salesName(S,c))}</strong><p>先选择新负责人，再核对交接范围。历史业务归属只有明确选择后才会调整。</p></div>`+select('owner_id','新负责人',[['','请选择新负责人'],...owners],'','required')+select('ownership_scope','交接范围',[['customer_only','客户后续维护交接'],['linked_records','同时调整原负责人名下的关联业务']],'customer_only','required')+'<div class="wide customer-transfer-preview" id="customer-transfer-preview" aria-live="polite"><p>选择新负责人后查看交接影响。</p></div><input type="hidden" name="transfer_preview_token" value=""><label class="wide customer-transfer-confirm" data-transfer-confirm hidden><input type="checkbox" name="ownership_confirmed">已核对所列商机、合同及回款，确认同步调整其销售归属。</label>'+textarea('reason','交接原因','',true),type,id,'确认转交').replace('<form ',`<form data-previous-owner="${esc(c.owner_id??'')}" `);
  }
  if(type==='customer'||type==='edit-customer'){
    const editing=type==='edit-customer',c=S.customers.find(c=>c.id===Number(id))||{};
    if(editing&&(!c.id||!canEdit(S,c)))return empty(c.id?'当前账号无权维护该客户':'客户不存在');
    const levels=[['','未标注'],...[...new Set([...(S.rules.customer_levels||['A','B','C']),...(c.manual_level?[c.manual_level]:[])])].map(v=>[v,v])];
    const extended=input('parent_company','母公司',c.parent_company||'','text',false)+input('group_name','所属集团',c.group_name||'','text',false)+input('scale','客户规模',c.scale||'','text',false)+input('credit_code','统一社会信用代码',c.credit_code||'','text',false);
    const fields=input('name','客户全称',c.name||'')+input('short_name','客户简称',c.short_name||'','text',false)+(!editing?'<div class="wide customer-duplicate-hints" id="duplicate-hints" aria-live="polite"></div><label class="wide field-help customer-duplicate-ack" data-duplicate-ack hidden><input type="checkbox" name="duplicate_ack">已核对疑似同名档案，确为不同企业时允许新建</label>':'')+
      (S.actor.role==='admin'?ownerField(S,c,editing):`<p class="wide customer-form-owner">负责人：${esc(editing?salesName(S,c):S.actor.name)}</p>`)+select('manual_level','客户等级',levels,c.manual_level||'')+
      input('industry','行业',c.industry||'','text',false)+input('region','地区',c.region||'','text',false)+
      (editing?select('management_status','管理状态',['正常','流失','冻结'],managedStatus(c))+'<p class="wide customer-field-note">合作情况按有效签约记录展示；冻结仅为管理标记，仍可补录资料。</p>':'')+
      input('tags','企业标签',c.tags||'','text',false)+input('compliance_flag','流程 / 风险标记',c.compliance_flag||'','text',false)+textarea('note','客户备注',c.note||'')+
      `<details class="wide customer-form-extra"><summary>集团与企业信息（选填）</summary><div class="customer-form-extra-grid">${extended}</div></details>`+
      (editing&&S.actor.role==='admin'?'<p class="wide customer-field-note">调整负责人请使用客户详情中的“转交客户”，可先查看影响范围。</p>':'');
    return formShell(editing?'编辑客户资料':'新建客户',editing?'修改资料后保存，客户归属保持不变。':'先建立客户主档，联系人可在保存后继续添加。',fields,type,id,editing?'保存客户资料':'创建客户');
  }
  if(type==='contact'||type==='edit-contact'){
    const editing=type==='edit-contact',p=editing?S.contacts.find(p=>p.id===Number(id))||{}:{},c=editing?S.customers.find(c=>c.id===p.customer_id):S.customers.find(c=>c.id===Number(id));
    if(editing&&(!p.id||!c||!canEdit(S,c)))return empty(p.id?'当前账号无权维护该联系人':'联系人不存在');
    const fields=(!editing?select('customer_id','关联客户',[['','请选择客户'],...(options.customerOptions||[])],id||'','required'):`<p class="wide customer-form-owner">关联客户：${esc(c.name)}</p>`)+input('name','姓名',p.name||'')+input('title','职位',p.title||'','text',false)+input('phone','电话',p.phone||'','tel',false)+input('wechat','微信',p.wechat||'','text',false)+input('dingtalk','钉钉',p.dingtalk||'','text',false)+`<p class="wide customer-field-note">${editing&&!p.phone&&!p.wechat&&!p.dingtalk?'历史联系方式未提供，可先维护其他已知信息。':'电话、微信、钉钉至少填写一项。'}</p>`+select('role','决策角色',['决策人','影响者','使用人','把关人','我方PM'],p.role||'使用人')+select('attitude','当前态度',['中立','支持','反对'],p.attitude||'中立')+input('last_contact','最近触达',p.last_contact||'','date',false,`max="${esc(S.today)}"`)+(editing?select('active','联系状态',[['true','在用'],['false','停用（保留历史）']],p.archived_at?'false':'true'):'')+textarea('note','联系人备注',p.note||'');
    return formShell(editing?'编辑联系人':'添加联系人','',fields,type,id,editing?'保存联系人':'添加联系人');
  }
}
