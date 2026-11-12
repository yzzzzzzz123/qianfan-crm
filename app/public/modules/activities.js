import {esc,icon,badge,empty,actionButton as button,select,input,textarea,formShell,dateLabel} from '../ui.js';

const types=['手动跟进','线上会议','现场拜访','对客报价','晚会复盘'];
const sourceName=value=>['手动','手动跟进','线上会议','现场拜访','对客报价'].includes(value)?'手动':['系统','系统里程碑'].includes(value)?'系统':value||'未提供';
const normalized=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();
const pageSize=25;
const username=(S,id,fallback)=>fallback||(S.users||[]).find(u=>u.id===Number(id))?.name||'未分配';
const isSystem=e=>['系统','系统里程碑'].includes(e.activity_type)||sourceName(e.source)==='系统';
const canCorrect=(S,e,key)=>!!e.id&&!e.voided_at&&!e.minutes_record_id&&!isSystem(e)&&(e[key]??(S.actor.role==='admin'||S.actor.role==='sales'&&Number(e.user_id)===Number(S.actor.id)));
const asLegacy=a=>({...a,activity_id:a.id,credited_user_id:a.credited_user_id??a.user_id,legacy:true});
const targetFor=(S,e)=>{
  const opportunity=(S.opportunities||[]).find(o=>o.id===Number(e.opportunity_id));
  const customer=(S.customers||[]).find(c=>c.id===Number(opportunity?.customer_id??e.customer_id));
  return {opportunity,opportunityName:opportunity?.name||e.opportunity_name||'历史商机',customerId:opportunity?.customer_id??e.customer_id,customerName:customer?.short_name||customer?.name||e.customer_name||'客户'};
};

function hydratedEvents(S){
  const records=new Map((S.activities||[]).map(a=>[a.id,a]));
  return (S.activityEvents||[]).map(e=>{
    const a=records.get(e.activity_id)||{};
    return {...a,...e,id:e.id,activity_id:e.activity_id,summary:e.summary??a.summary??'',activity_date:e.activity_date||a.activity_date||'',user_id:e.user_id??a.user_id,minutes_record_id:e.minutes_record_id??a.minutes_record_id};
  });
}

function eventMatches(S,e,P){
  const target=targetFor(S,e),status=P.activityStatus||'active';
  if(status==='active'&&e.voided_at||status==='voided'&&!e.voided_at)return false;
  if(S.actor.role==='sales'&&Number(e.user_id)!==Number(S.actor.id)&&Number(e.credited_user_id)!==Number(S.actor.id))return false;
  if(P.activityFrom&&e.activity_date<P.activityFrom||P.activityTo&&e.activity_date>P.activityTo)return false;
  if(P.activityOwner&&Number(e.user_id)!==Number(P.activityOwner)&&Number(e.credited_user_id)!==Number(P.activityOwner))return false;
  if(P.activityCustomer&&Number(target.customerId)!==Number(P.activityCustomer)||P.activityOpportunity&&Number(e.opportunity_id)!==Number(P.activityOpportunity))return false;
  if(P.activitySource&&sourceName(e.source)!==P.activitySource||P.activityType&&(P.activityType==='系统'?!isSystem(e):e.activity_type!==P.activityType))return false;
  if(P.source&&(types.includes(P.source)?e.activity_type!==P.source:e.source!==P.source&&sourceName(e.source)!==sourceName(P.source)))return false;
  const query=normalized(P.activityQ).split(' ').filter(Boolean),haystack=normalized([e.summary,e.action,e.activity_type,e.source,target.opportunityName,target.customerName,username(S,e.user_id,e.user_name),username(S,e.credited_user_id,e.credited_user_name)].join(' '));
  return query.every(q=>haystack.includes(q));
}

export function selectActivityGroups(S,P={}){
  const records=new Map((S.activities||[]).map(a=>[a.id,a])),all=hydratedEvents(S),tracked=new Set(all.map(e=>e.activity_id)),groups=new Map(),byActivity=new Map();
  for(const e of all){if(!byActivity.has(e.activity_id))byActivity.set(e.activity_id,[]);byActivity.get(e.activity_id).push(e);}
  for(const e of all){
    if(!eventMatches(S,e,P))continue;
    if(!groups.has(e.activity_id))groups.set(e.activity_id,{record:records.get(e.activity_id)||e,events:[],allEvents:byActivity.get(e.activity_id)});
    groups.get(e.activity_id).events.push(e);
  }
  for(const a of records.values()){
    if(tracked.has(a.id))continue;
    const e=asLegacy(a);
    if(eventMatches(S,e,P))groups.set(a.id,{record:a,events:[e],allEvents:[e]});
  }
  return [...groups.values()].map(g=>({...g,day:g.events.map(e=>e.activity_date).sort().at(-1)||g.record.activity_date})).sort((a,b)=>String(b.day).localeCompare(String(a.day))||Number(b.record.activity_id||b.record.id)-Number(a.record.activity_id||a.record.id));
}

function filterSelect(id,label,options,value=''){
  return `<label>${esc(label)}<select id="${id}" aria-label="${esc(label)}">${options.map(([v,t])=>`<option value="${esc(v)}" ${String(v)===String(value)?'selected':''}>${esc(t)}</option>`).join('')}</select></label>`;
}

function scoreLabel(e){
  if(e.voided_at)return badge('已作废','neutral')+(e.score?.locked?'<span class="activity-locked-label">该月绩效已锁定，历史评分保持快照</span>':'');
  if(e.score){
    const label=e.score.counted?(typeof e.score.points==='number'&&Number.isFinite(e.score.points)?`计分 ${e.score.points} 分`:'已纳入历史依据'):e.score.reason||'不计入过程分';
    return badge(label,e.score.counted?'success':'neutral')+(e.score.locked?'<span class="activity-locked-label">该月绩效已锁定</span>':'');
  }
  return `<span class="activity-score-pending">${e.legacy?'历史汇总记录，计分以绩效依据为准':isSystem(e)?'系统记录，不计分':'计分状态待刷新'}</span>`;
}

function opportunityLink(S,e){
  const target=targetFor(S,e);
  return target.opportunity?`<button class="text-link activity-target" data-action="opportunity" data-id="${Number(e.opportunity_id)}">${esc(target.opportunityName)}</button>`:`<strong class="activity-target">${esc(target.opportunityName)}</strong><span class="activity-history-label">历史记录${e.opportunity_archived?' · 商机已归档':''}</span>`;
}

const sourceNotice=e=>e.source_notice?`<p class="activity-source-notice activity-lock-note">${esc(e.source_notice)}</p>`:'';

function eventCard(S,e,detail=false){
  const recordName=username(S,e.user_id,e.user_name),creditedName=username(S,e.credited_user_id,e.credited_user_name);
  const prefix=e.legacy?'activity-legacy':'activity-event';
  return `<article class="activity-event ${e.voided_at?'is-voided':''}" data-event-id="${Number(e.id)||''}"><div class="activity-event-heading"><div>${badge(e.activity_type||'跟进','blue')}${badge(sourceName(e.source))}</div><time datetime="${esc(e.activity_date)}">${esc(dateLabel(e.activity_date))}</time></div>${sourceNotice(e)}<p class="activity-event-content">${esc(e.summary)}</p>${e.action?`<p class="activity-event-action"><b>下一步：</b>${esc(e.action)}</p>`:''}<div class="activity-event-people"><span>登记人：${esc(recordName)}</span>${e.credited_user_id?`<span>计分归属：${esc(creditedName)}</span>`:''}</div><div class="activity-event-score">${scoreLabel(e)}</div>${e.score?.reason&&e.score.counted?`<p class="activity-score-reason">${esc(e.score.reason)}</p>`:''}${e.void_reason?`<p class="activity-void-reason">作废原因：${esc(e.void_reason)}</p>`:''}${e.updated_at?`<p class="activity-edited-label">已更正 · ${esc(dateLabel(e.updated_at))}</p>`:''}<div class="activity-event-actions">${!detail&&e.id?button('查看详情',prefix+'-detail',e.id,'ghost'):''}${canCorrect(S,e,'can_edit')?button('更正',prefix+'-edit',e.id,'ghost','edit'):''}${canCorrect(S,e,'can_void')?button('作废',prefix+'-void',e.id,'ghost'):''}</div></article>`;
}

function groupCard(S,group){
  const {events,allEvents,day}=group,first=events[0],target=targetFor(S,first),active=events.filter(e=>!e.voided_at),summaries=[...new Set(events.map(e=>e.summary).filter(Boolean))];
  const latest=events.find(e=>e.action),partial=events.length!==allEvents.length,raw=events.some(e=>!e.legacy),scored=active.filter(e=>e.score?.counted).length;
  return `<article class="activity-record" data-activity-id="${Number(first.activity_id)}"><div class="activity-record-heading"><div class="activity-record-owner">${icon('note')}<b>${esc(username(S,first.user_id,first.user_name))}</b>${badge([...new Set(events.map(e=>sourceName(e.source)))].join(' / '),'blue')}</div><time datetime="${esc(day)}">${esc(dateLabel(day))}</time></div><div class="activity-record-target">${opportunityLink(S,first)}<span>${esc(target.customerName)}</span></div>${sourceNotice(first)}<p class="activity-record-summary">${esc(summaries.join('\n'))}</p>${latest?.action?`<div class="activity-record-next">${icon('arrow')}<span>下一步：${esc(latest.action)}</span></div>`:''}<details class="activity-event-list"><summary>${raw?`查看原始记录（${events.length} 次${partial?` / 该组共 ${allEvents.length} 次`:''}）`:'查看历史记录'}${scored?`<span>计分行为 ${scored} 次</span>`:''}</summary>${partial?'<p class="activity-filter-note">以下仅展示符合当前筛选条件的原始记录。</p>':''}${events.map(e=>eventCard(S,e)).join('')}</details></article>`;
}

export function activities(S,P={}){
  const groups=selectActivityGroups(S,P),events=groups.flatMap(g=>g.events),active=events.filter(e=>!e.voided_at),counted=active.filter(e=>e.score?.counted),page=Math.max(1,Math.min(Math.ceil(groups.length/pageSize)||1,Number(P.activityPage)||1)),shown=groups.slice((page-1)*pageSize,page*pageSize),all=hydratedEvents(S);
  const users=(S.users||[]).filter(u=>u.active||all.some(e=>e.user_id===u.id||e.credited_user_id===u.id));
  const customers=new Map((S.customers||[]).map(c=>[c.id,c.short_name||c.name])),opportunities=new Map((S.opportunities||[]).map(o=>[o.id,{name:o.name,customerId:o.customer_id}]));
  for(const e of all){const t=targetFor(S,e);if(t.customerId&&!customers.has(t.customerId))customers.set(t.customerId,t.customerName);if(!opportunities.has(e.opportunity_id))opportunities.set(e.opportunity_id,{name:t.opportunityName,customerId:t.customerId});}
  const customerOptions=[['','全部客户'],...[...customers].sort((a,b)=>String(a[1]).localeCompare(String(b[1]),'zh-CN'))];
  const opportunityOptions=[['','全部商机'],...[...opportunities].filter(([,o])=>!P.activityCustomer||Number(o.customerId)===Number(P.activityCustomer)).map(([id,o])=>[id,o.name])];
  return `<div class="activity-workspace"><section class="panel activity-toolbar"><div class="activity-toolbar-top"><p>${S.actor.role==='sales'?'我的跟进与计分依据':S.actor.role==='admin'?'团队跟进与计分依据':'协作商机的跟进记录'}<small>同日记录合并展示，逐次行为展开核对。</small></p><div>${button('刷新记录','activity-refresh','','secondary','refresh')}${button('重置筛选','activity-reset','','ghost')}</div></div><div class="activity-filters"><label class="activity-search-label">搜索记录<input id="activity-search" type="search" value="${esc(P.activityQ||'')}" placeholder="客户、商机、沟通内容或人员" aria-label="搜索跟进记录" autocomplete="off"></label><label>发生日期从<input id="activity-from" type="date" value="${esc(P.activityFrom||'')}" aria-label="跟进开始日期"></label><label>至<input id="activity-to" type="date" value="${esc(P.activityTo||'')}" aria-label="跟进结束日期"></label>${S.actor.role==='admin'?filterSelect('activity-owner','人员（登记／计分）',[['','全部人员'],...users.map(u=>[u.id,u.name+(u.active?'':' · 已停用')])],P.activityOwner):''}${filterSelect('activity-customer','客户',customerOptions,P.activityCustomer)}${filterSelect('activity-opportunity','商机',opportunityOptions,P.activityOpportunity)}${filterSelect('activity-source','内容来源',[['','全部来源'],['手动','手动'],['AI听记','AI听记'],['晚会复盘','晚会复盘'],['系统','系统']],P.activitySource)}${filterSelect('activity-type','行为类型',[['','全部类型'],...types.map(t=>[t,t]),['听记摘要','听记摘要'],['系统','系统记录']],P.activityType)}${filterSelect('activity-status','记录状态',[['active','有效记录'],['all','含已作废'],['voided','仅已作废']],P.activityStatus||'active')}</div>${P.activityFrom&&P.activityTo&&P.activityFrom>P.activityTo?'<p class="activity-filter-warning" role="status">开始日期晚于结束日期，请调整日期范围。</p>':''}<div class="activity-result-count" aria-live="polite"><span>匹配 <b>${groups.length}</b> 组跟进</span><span>原始记录 <b>${events.length}</b> 条</span><span>有效计分行为 <b>${counted.length}</b> 次</span>${events.some(e=>e.legacy)?'<small>含历史汇总，次数以可追溯原始记录为准</small>':''}</div></section><div class="activity-record-list">${shown.map(group=>groupCard(S,group)).join('')||empty('没有匹配的跟进记录','调整日期、人员或关键词后再试。')}${groups.length>pageSize?`<nav class="activity-pagination" aria-label="跟进记录分页"><span>第 ${page} / ${Math.ceil(groups.length/pageSize)} 页 · 每页 ${pageSize} 组</span><div>${page>1?button('上一页','activity-page',page-1,'secondary'):''}${page*pageSize<groups.length?button('下一页','activity-page',page+1,'secondary'):''}</div></nav>`:''}</div></div>`;
}

const findEvent=(S,id,legacy=false)=>legacy?(()=>{const row=(S.activities||[]).find(a=>Number(a.id)===Number(id)&&!(S.activityEvents||[]).some(e=>e.activity_id===a.id));return row?asLegacy(row):null;})():hydratedEvents(S).find(e=>Number(e.id)===Number(id));
function lockHint(S,e,date){
  const owner=e?.credited_user_id||(S.opportunities||[]).find(o=>o.id===Number(e?.opportunity_id))?.owner_id;
  const locked=(S.performanceLocks||[]).some(p=>Number(p.user_id)===Number(owner)&&p.month===String(date||'').slice(0,7));
  return locked?'该月份绩效已锁定。记录仍会保存，但不会自动改变已锁定评分；如需调整，请由管理员复核。':'';
}

export function activityEventDetail(S,id,legacy=false){
  const e=findEvent(S,id,legacy);if(!e)return empty('记录不存在或无权查看');
  const target=targetFor(S,e);
  return `<header class="dialog-head"><div><h2>跟进原始记录</h2><p>${esc(target.customerName)} · ${esc(target.opportunityName)}</p></div><button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="dialog-body activity-event-detail">${eventCard(S,e,true)}${e.score?.locked?'<p class="activity-lock-note">该月绩效已锁定，当前原始记录与锁定时采用的依据可能不同。历史评分以锁定快照为准。</p>':''}</div><footer class="dialog-footer"><button type="button" class="btn secondary" data-action="close">关闭</button></footer>`;
}

export function formActivities(S,type,id,options={}){
  if(['activity-event-edit','activity-event-void','activity-legacy-edit','activity-legacy-void'].includes(type)){
    const e=findEvent(S,id,type.startsWith('activity-legacy'));if(!e)return empty('记录不存在或无权维护');
    const voiding=type.endsWith('-void');
    if(!canCorrect(S,e,voiding?'can_void':'can_edit'))return empty('此记录不可更正或作废','听记及系统记录保留来源，已作废记录只供查阅。');
    const target=targetFor(S,e);
    const sources=['手动','AI听记','晚会复盘'];
    const sourceOptions=sources.includes(e.source)?sources:[[e.source,`${sourceName(e.source)}（原来源）`],...sources];
    const fields=`<input type="hidden" name="expected_updated_at" value="${esc(e.legacy?e.legacy_version||e.updated_at||e.created_at||'':e.updated_at||e.created_at||'')}"><div class="wide activity-correction-context"><b>${esc(target.customerName)} · ${esc(target.opportunityName)}</b><p>登记人：${esc(username(S,e.user_id,e.user_name))} · 计分归属：${esc(username(S,e.credited_user_id,e.credited_user_name))}</p>${voiding?`<p>${esc(e.summary)}</p>`:''}</div>`+(voiding?'':select('activity_type','跟进类型',types,e.activity_type)+select('source','内容来源',sourceOptions,e.source)+input('activity_date','发生日期',e.activity_date,'date',true,`max="${S.today}"`)+textarea('summary','沟通内容与结论',e.summary,true)+textarea('action','本次记录的下一步动作',e.action||''))+textarea('reason',voiding?'作废原因':'更正原因','',true)+`<p class="wide activity-correction-note">${voiding?'作废后保留原文与原因，该行为不再参与未锁定绩效计分。':'更正只影响本次原始记录及未锁定绩效，不会覆盖商机当前行动计划。'}</p><p class="wide activity-lock-note" data-activity-lock-hint aria-live="polite">${esc(lockHint(S,e,e.activity_date))}</p>`;
    return formShell(voiding?'作废跟进记录':'更正跟进记录','保存前请核对记录与计分影响，历史操作会保留。',fields,type,id,voiding?'确认作废':'保存更正');
  }
  if(type==='activity'){
    const o=(S.opportunities||[]).find(o=>o.id===Number(id));
    return formShell('记录一次跟进','',select('opportunity_id','关联商机',[['','请选择关联商机'],...(options.oppOptions||[])],id||'','required')+select('activity_type','跟进类型',types)+select('source','内容来源',['手动','AI听记','晚会复盘'],'手动')+input('activity_date','发生日期',S.today,'date',true,`max="${S.today}"`)+textarea('summary','沟通内容与结论','',true)+'<p class="wide activity-form-helper">简要记录客户反馈、达成的结论及仍需解决的问题。</p>'+textarea('action','下一步动作',o?.next_action||'')+input('follow_date','下次跟进日期',o?.follow_date||S.today,'date',false)+'<p class="wide activity-score-note" data-activity-score-hint></p><p class="wide activity-lock-note" data-activity-lock-hint aria-live="polite"></p><section class="wide activity-plan-panel"><label class="activity-plan-check"><input type="checkbox" name="update_plan">同时更新商机当前的下一步与跟进日期</label><p class="activity-plan-note">补录历史沟通时默认保留现行计划；需要同步调整时可勾选，并核对下方变化。</p><div data-activity-plan-preview aria-live="polite"></div></section>',type,id,'保存跟进');
  }
}

export function mountActivityForm(form,S){
  if(!form||!['activity','activity-event-edit','activity-event-void','activity-legacy-edit','activity-legacy-void'].includes(form.dataset.form))return;
  const sync=()=>{
    const e=form.dataset.form==='activity'?{opportunity_id:Number(form.elements.opportunity_id?.value)}:findEvent(S,form.dataset.id,form.dataset.form.startsWith('activity-legacy'));
    const lock=form.querySelector('[data-activity-lock-hint]');if(lock){lock.textContent=lockHint(S,e,form.elements.activity_date?.value||e?.activity_date);lock.hidden=!lock.textContent;}
    const score=form.querySelector('[data-activity-score-hint]');if(score){const type=form.elements.activity_type?.value;score.textContent=['线上会议','现场拜访','对客报价'].includes(type)?'本行为按有效原始依据计入过程绩效；同一次行为的补充请更正原记录，避免重复登记。':'普通跟进与复盘用于记录沟通，本身不增加过程分。';}
  };
  form.addEventListener('change',sync);sync();
}
