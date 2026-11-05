import {esc,icon,badge,empty,actionButton as button} from '../ui.js';
import {api,basePath,simulationIdentity} from '../api.js';
import {minuteArtifact} from './minutes-artifacts.js';

const date=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'尚未采集';
const runLabels={running:'同步中',success:'已完成',partial:'部分正文待读取',failed:'未完成'};
const shortDay=value=>value?new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,10):'';
const duration=ms=>`${Math.floor(ms/60000)} 分 ${Math.floor(ms/1000)%60} 秒`;
function dateProblem(p,today){
  if(!!p.minutesFrom!==!!p.minutesTo)return p.minutesFrom?'请选择结束日期以应用筛选':'请选择开始日期以应用筛选';
  if(p.minutesFrom&&p.minutesTo&&p.minutesFrom>p.minutesTo)return '开始日期不能晚于结束日期';
  if(p.minutesTo&&p.minutesTo>today)return '听记日期不能晚于今天';
  return '';
}

function pagination(data,pageSize){
  const current=data.page||1,last=Math.max(1,Math.ceil((data.count||0)/pageSize)),start=Math.max(1,Math.min(current-2,last-4));
  return `<div class="table-footer minutes-pagination"><span>共 ${data.count||0} 条</span><div><button class="minutes-page-number" aria-label="上一页" data-action="minutes-page" data-id="${current-1}" ${current<=1?'disabled':''}>${icon('chevron','minutes-prev')}</button>${start>1?`<button class="minutes-page-number" data-action="minutes-page" data-id="1">1</button><span>…</span>`:''}${Array.from({length:Math.min(5,last)},(_,i)=>{const n=start+i;return `<button class="minutes-page-number ${current===n?'active':''}" aria-label="第 ${n} 页" ${current===n?'aria-current="page"':''} data-action="minutes-page" data-id="${n}">${n}</button>`;}).join('')}${start+4<last?`<span>…</span><button class="minutes-page-number" data-action="minutes-page" data-id="${last}">${last}</button>`:''}<button class="minutes-page-number" aria-label="下一页" data-action="minutes-page" data-id="${current+1}" ${current>=last?'disabled':''}>${icon('chevron')}</button></div></div>`;
}
function listTable(data,context=''){
  if(!data.records?.length)return `<div class="table-scroll"><table class="data-table minutes-table"><thead><tr>${['闪记','时长','录音','活动认定','操作'].map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody><tr class="minutes-empty-row"><td colspan="5">${empty('当前范围暂无听记','')}</td></tr></tbody></table></div>`;
  return data.records?.length?`<div class="table-scroll"><table class="data-table minutes-table"><thead><tr><th>闪记</th><th>时长</th><th>录音</th><th>活动认定</th><th>操作</th></tr></thead><tbody>${data.records.map(r=>`<tr><td><button class="minutes-title" data-action="minutes-detail" data-id="${r.id}" data-context="${esc(context)}">${esc(r.title)}</button><span class="record-meta">${esc(r.account_name)} · ${esc(date(r.start_time))}</span></td><td>${esc(duration(r.duration_ms))}</td><td><div class="minutes-media">${badge(r.media_state==='available'?'可回放':r.media_state==='unsupported'?'回放受限':'暂不可回放',r.media_state==='available'?'success':'neutral')}<span class="record-meta">${r.media_state==='available'?'已确认有录音':'录音存在性待核验'}</span>${r.media_reason?`<span class="record-meta">${esc(r.media_reason)}</span>`:''}</div></td><td>${esc({visit:'外出拜访',demo:'线上演示'}[r.recognized_type]||'待认定')}${r.recognition_reason?`<span class="record-meta">${esc(r.recognition_reason)}</span>`:''}</td><td><div class="minutes-row-actions">${button('查看正文','minutes-detail',r.id,'ghost')}${r.media_state==='available'?button('回放录音','minutes-play',r.id,'ghost'):''}</div></td></tr>`).join('')}</tbody></table></div>`:empty('当前范围暂无听记','');
}
function runsTable(runs,sources){
  if(!runs.length)return `<div class="table-scroll"><table class="data-table minutes-run-table"><thead><tr>${['同步范围','状态','处理结果','操作'].map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody><tr class="minutes-empty-row"><td colspan="4">${empty('暂无同步任务','')}</td></tr></tbody></table></div>`;
  return runs.length?`<div class="table-scroll"><table class="data-table minutes-run-table"><thead><tr><th>同步范围</th><th>状态</th><th>处理结果</th><th>操作</th></tr></thead><tbody>${runs.slice(0,8).map(r=>`<tr><td>${r.from_time.startsWith('1970-')?'全部历史':esc(date(r.from_time))} —<span class="record-meta">${esc(date(r.to_time))}（结束不含）</span></td><td>${badge(r.status==='partial'?'已完成':runLabels[r.status]||r.status,['success','partial'].includes(r.status)?'success':r.status==='failed'?'warning':'blue')}${r.status==='partial'?'<span class="record-meta">部分正文尚未返回</span>':r.status==='success'?'<span class="record-meta">正文读取完成</span>':''}</td><td>读取 ${r.fetched} · ${r.pages} 页${r.error_message?`<span class="record-meta text-warning">${esc(r.error_message)}</span>`:''}</td><td>${r.status==='failed'?button('断点重试','minutes-run-retry',r.id,'ghost'):r.status==='running'?'处理中':'已保存'}</td></tr>`).join('')}</tbody></table></div>`:empty('暂无同步任务','');
}
export function minutesPage(S,P){
  if(S.actor.role==='pm')return empty('当前账号无权访问','听记按销售账号及客户、商机权限查看。');
  const m=S.minutes||{},data=P.minutesData||m,sources=m.sources||[],runs=data.runs||m.runs||[],totals=data.totals||{total:data.count||0},tab=P.minutesTab||'notes',pageSize=data.page_size||10;

  const duplicateNames=new Set(sources.filter(s=>sources.some(other=>other.id!==s.id&&other.account_name===s.account_name)).map(s=>s.account_name));
  return `<div class="minutes-workspace" id="minutes-records"><div class="minutes-totals">${[['已同步闪记',totals.total],['可回放录音',totals.available],['录音接口受限',totals.unsupported],['已认定活动',totals.recognized]].map(([label,value])=>`<div class="minutes-total"><span>${label}</span><strong>${Number(value)||0}</strong></div>`).join('')}</div><section class="panel minutes-content"><form class="minutes-tools" data-form="minutes-filter"><label>闪记账号<select name="source_id" aria-label="闪记账号"><option value="">全部成员</option>${sources.map(s=>`<option value="${s.id}" ${P.minutesSource===s.id?'selected':''}>${esc(s.account_name)}${duplicateNames.has(s.account_name)?' · '+esc(s.corp_name):''}</option>`).join('')}</select></label><div class="minutes-filter-field minutes-dates"><span>发生日期</span><div data-minutes-date-range></div><span data-minutes-date-error class="minutes-filter-error" role="status" ${dateProblem(P,S.today)?'':'hidden'}>${esc(dateProblem(P,S.today))}</span></div></form><nav class="minutes-tabs" aria-label="听记内容">${[['notes','闪记与录音'],['runs','同步记录']].map(([id,label])=>`<button type="button" role="tab" aria-selected="${tab===id}" data-action="minutes-tab" data-id="${id}" class="${tab===id?'active':''}">${label}</button>`).join('')}</nav><p class="minutes-hint">${tab==='runs'?'展示最近八次任务，按页保存。重复同步更新同一来源记录；失败后可从最后成功页断点重试。':'点击标题在 CRM 查看听记详情。源标签逐条核验；未配置分类对应关系或录音存在性未确认的记录保留待认定。'}</p>${tab==='runs'?runsTable(runs,sources):`${listTable(data)}${pagination(data,pageSize)}`}</section></div>`;
}
export function linkedMinutes(kind,id){return `<section class="detail-section"><h3>钉钉听记</h3><p class="muted">查看明确关联到此${kind==='customer'?'客户':'商机'}的听记、总结与录音。</p><button class="btn secondary" data-action="minutes-context" data-id="${id}" data-kind="${kind}">查看关联听记 ${icon('chevron')}</button></section>`;}
const queryContext=text=>Object.fromEntries(new URLSearchParams(text||''));
export function createMinutesController({getS,getP,openHtml,content,reload,toast}){
  const autoArtifacts=new Set();
  let currentRecord=null,currentContext='',audioUrl=null,polling=false,lastPoll=0,detailTab='summary',speakerTimer=null,speakerPolls=0,detailEpoch=0,listEpoch=0,calendarEpoch=0,calendarHandle=null;
  function dateError(p){
    return dateProblem(p,getS().today);
  }
  function updateDateControls(form=document.querySelector('form[data-form="minutes-filter"]')){
    const error=form?.querySelector('[data-minutes-date-error]');if(error){error.textContent=dateError(getP());error.hidden=!error.textContent;}
  }
  function beforeRender(){calendarEpoch++;calendarHandle?.destroy();calendarHandle=null;}
  async function mountFilters(){
    const host=document.querySelector('[data-minutes-date-range]');if(!host)return;
    const epoch=calendarEpoch,p=getP();
    try{
      const {mountMinutesDateRange}=await import('../widgets/minutes-date-range.js');
      if(epoch!==calendarEpoch||!host.isConnected)return;
      calendarHandle=mountMinutesDateRange(host,{value:p.minutesFrom&&p.minutesTo?[p.minutesFrom,p.minutesTo]:[],onChange:dates=>{
        if(epoch!==calendarEpoch||getP()!==p)return;
        p.minutesFrom=dates[0]||'';p.minutesTo=dates[1]||'';void refreshList().catch(err=>toast(err.message,true));
      }});
    }catch(e){if(epoch===calendarEpoch)toast('日期筛选组件加载失败，请刷新页面重试',true);}
  }
  function renderList(){
    const root=document.querySelector('#minutes-records');if(!root){content();return;}
    const template=document.createElement('template');template.innerHTML=minutesPage(getS(),getP());
    root.querySelector('.minutes-totals').replaceWith(template.content.querySelector('.minutes-totals'));
    const panel=root.querySelector('.minutes-content'),next=template.content.querySelector('.minutes-content');
    // Keep the actual date inputs mounted while asynchronous results change.
    for(const child of [...panel.children])if(!child.matches('.minutes-tools'))child.remove();
    for(const child of [...next.children])if(!child.matches('.minutes-tools'))panel.append(child);
    updateDateControls();
  }
  function saveDrafts(){
    const fields=[...document.querySelectorAll('form[data-form="minutes-filter"] input,form[data-form="minutes-filter"] select')].filter(el=>el.name).map(el=>({form:el.form.dataset.form,name:el.name,value:el.value,focused:el===document.activeElement,start:el.selectionStart,end:el.selectionEnd}));
    return ()=>{for(const f of fields){const el=document.querySelector(`form[data-form="${f.form}"] [name="${f.name}"]`);if(!el)continue;el.value=f.value;if(f.focused){el.focus({preventScroll:true});if(f.start!==null&&f.start!==undefined&&['text','search'].includes(el.type))el.setSelectionRange(f.start,f.end);}}};
  }
  const releaseAudio=()=>{if(audioUrl){URL.revokeObjectURL(audioUrl);audioUrl=null;}};
  const stopSpeakerPolling=()=>{clearTimeout(speakerTimer);speakerTimer=null;};
  const closeDetail=()=>{detailEpoch++;currentRecord=null;stopSpeakerPolling();releaseAudio();};
  const speakerBody=generate=>({generate,...Object.fromEntries(Object.entries(queryContext(currentContext)).map(([k,v])=>[k,Number(v)]))});
  function pollSpeaker(){
    stopSpeakerPolling();
    if(currentRecord?.artifacts?.speaker_insights?.state!=='pending'||!currentRecord.can_manage||detailTab!=='speaker_insights'||speakerPolls>=20||!document.querySelector('#dialog')?.open)return;
    const id=currentRecord.id,context=currentContext,epoch=detailEpoch;
    speakerTimer=setTimeout(async()=>{
      if(document.hidden){pollSpeaker();return;}
      try{
        speakerPolls++;await api(`/minutes/records/${id}/speaker-insights`,{method:'POST',body:speakerBody(false)});
        if(epoch===detailEpoch&&currentRecord?.id===id&&detailTab==='speaker_insights'&&document.querySelector('#dialog')?.open)await showRecord(id,context,'speaker_insights',true);
      }catch(e){if(epoch===detailEpoch)toast(e.message,true);}
    },5000);
  }
  async function ensureArtifact(){
    const kind=detailTab,r=currentRecord,epoch=detailEpoch,context=currentContext;
    if(!r?.can_manage||!['speaker_insights','quality','transcript'].includes(kind)||r.artifacts[kind]?.state==='ready'||!document.querySelector('#dialog')?.open)return;
    const key=`${epoch}:${kind}`;if(autoArtifacts.has(key))return;autoArtifacts.add(key);
    const paint=a=>{if(epoch!==detailEpoch||currentRecord?.id!==r.id)return;currentRecord.artifacts[kind]=a;const section=document.querySelector(`[data-minute-artifact="${kind}"]`);if(section)section.outerHTML=minuteArtifact(kind,a,r.id,true,detailTab,r.artifacts.summary);};
    paint({state:'pending',content:r.artifacts[kind]?.content||'',reason:kind==='quality'?'正在分析会议正文…':kind==='transcript'?'正在读取钉钉逐字稿…':'正在读取钉钉发言人观点…'});
    try{
      await api(`/minutes/records/${r.id}/${kind==='speaker_insights'?'speaker-insights':kind}`,{method:'POST',body:kind!=='speaker_insights'?Object.fromEntries(Object.entries(queryContext(context)).map(([k,v])=>[k,Number(v)])):speakerBody(true)});
      if(epoch===detailEpoch&&document.querySelector('#dialog')?.open)await showRecord(r.id,context,detailTab,true);
    }catch(e){paint({state:'failed',content:r.artifacts[kind]?.content||'',reason:e.message});}
  }
  async function refreshList(page=1){
    const p=getP(),epoch=++listEpoch,actor=getS()?.actor?.id;updateDateControls();if(dateError(p))return;
    const q=new URLSearchParams({page:String(page)});if(p.minutesQ)q.set('q',p.minutesQ);if(p.minutesSource)q.set('source_id',p.minutesSource);if(p.minutesFrom)q.set('from',p.minutesFrom);if(p.minutesTo)q.set('to',p.minutesTo);q.set('page_size',String(p.minutesPageSize||10));
    const key=JSON.stringify([p.minutesSource,p.minutesFrom,p.minutesTo,p.minutesQ,p.minutesPageSize]),current=()=>epoch===listEpoch&&getP()===p&&getS()?.actor?.id===actor&&JSON.stringify([p.minutesSource,p.minutesFrom,p.minutesTo,p.minutesQ,p.minutesPageSize])===key;
    try{const result=await api('/minutes?'+q);if(current()){p.minutesData=result;renderList();}}catch(e){if(current())throw e;}
  }
  async function reloadPage(){getP().minutesData=null;await reload();if(getP().view==='minutes'&&(getP().minutesQ||getP().minutesSource||getP().minutesFrom||getP().minutesTo))await refreshList();}
  async function showContext(context,page=1){closeDetail();currentContext=context;const q=new URLSearchParams(context);q.set('page',page);const d=await api('/minutes?'+q);openHtml(`<header class="dialog-head"><h2>关联钉钉听记</h2><button class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="drawer-body">${listTable(d,context)}<div class="table-footer">共 ${d.count} 条 · 第 ${d.page} 页<div>${d.page>1?`<button class="btn ghost" data-action="minutes-context-page" data-id="${d.page-1}" data-context="${esc(context)}">上一页</button>`:''}${d.page*(d.page_size||10)<d.count?`<button class="btn ghost" data-action="minutes-context-page" data-id="${d.page+1}" data-context="${esc(context)}">下一页</button>`:''}</div></div></div>`,true);}
  async function showRecord(id,context='',selectedTab='summary',continuing=false){
    stopSpeakerPolling();if(!continuing){detailEpoch++;speakerPolls=0;autoArtifacts.clear();}const epoch=detailEpoch;
    releaseAudio();const S=getS(),r=await api(`/minutes/records/${id}${context?'?'+context:''}`);if(epoch!==detailEpoch)return;currentRecord=r;currentContext=context;
    const artifacts=[['summary','AI 总结'],['speaker_insights','AI 发言人观点提炼'],['quality','AI 会议质检'],['transcript','转写正文']];detailTab=selectedTab;
    const owner=S.minutes?.sources?.find(s=>s.id===r.source_id)?.account_name||'';
    const customer=r.customer_id?S.customers.find(c=>c.id===r.customer_id)?.name||'已关联客户':'';
    openHtml(`<header class="dialog-head"><h2>${esc(r.title)}</h2><button class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="drawer-body"><p class="minutes-hint">${esc(date(r.start_time))} · ${esc(duration(r.duration_ms))} · ${esc(owner)}</p><div class="minutes-detail-business"><p>${customer?'关联客户：'+esc(customer):'尚未确认关联客户或商机，正文不会自动归入业务跟进。'}</p>${r.can_manage?button(customer?'更换 / 取消业务关联':'关联客户 / 商机','minutes-association-toggle',r.id,'secondary'):''}</div><p class="minutes-hint">听记自动摘要独立保留，不计入手工 SOP 跟进。</p><p class="minutes-origin"><a href="https://shanji.dingtalk.com/app/transcribes/${encodeURIComponent(r.external_id)}" target="_blank" rel="noopener noreferrer">在钉钉查看原记录</a></p><nav class="minutes-tabs minutes-detail-tabs" aria-label="听记详情">${artifacts.map(([key,label])=>`<button role="tab" aria-selected="${key===detailTab}" class="${key===detailTab?'active':''}" data-action="minutes-detail-tab" data-id="${key}">${label}</button>`).join('')}</nav>${r.can_manage?`<form hidden data-minute-artifact="association" data-form="minutes-association" data-id="${r.id}" class="minutes-association"><h3>关联业务档案</h3><p class="field-help">选择商机时同时关联其客户；留空并填写说明可取消关联。</p><label class="field">客户<select name="customer_id"><option value="">不指定客户</option>${S.customers.filter(c=>!c.shared).map(c=>`<option value="${c.id}" ${r.customer_id===c.id?'selected':''}>${esc(c.name)}</option>`).join('')}</select></label><label class="field">商机<select name="opportunity_id"><option value="">不指定商机</option>${S.opportunities.map(o=>`<option value="${o.id}" ${r.opportunity_id===o.id?'selected':''}>${esc(S.customers.find(c=>c.id===o.customer_id)?.name||'')} · ${esc(o.name)}</option>`).join('')}</select></label><label class="field">关联或取消说明<input name="reason" required maxlength="500"></label><p class="form-error" role="alert"></p><button class="btn secondary" type="submit">保存关联</button></form>`:''}${artifacts.map(([key])=>minuteArtifact(key,r.artifacts[key],r.id,r.can_manage,detailTab,r.artifacts.summary)).join('')}<div id="minutes-player">${r.media_state==='available'?button('回放录音','minutes-audio',r.id,'secondary','activities'):''}</div></div>`,false);document.querySelector('#dialog')?.classList.add('minutes-dialog');pollSpeaker();void ensureArtifact();
  }
  async function click(action,id,el){
    if(!action.startsWith('minutes-'))return false;
    if(action==='minutes-tab'){getP().minutesTab=id;renderList();return true;}
    if(action==='minutes-association-toggle'){const form=document.querySelector('[data-form="minutes-association"]');if(form)form.hidden=!form.hidden;return true;}
    if(action==='minutes-detail-tab'){detailTab=id;document.querySelectorAll('[data-minute-artifact]').forEach(section=>section.hidden=section.dataset.minuteArtifact!==id);document.querySelectorAll('[data-action="minutes-detail-tab"]').forEach(b=>{b.classList.toggle('active',b.dataset.id===id);b.setAttribute('aria-selected',String(b.dataset.id===id));});pollSpeaker();void ensureArtifact();return true;}

    if(action==='minutes-range-sync'||action==='minutes-run-retry'){
      const p=getP(),s=getS();let sourceId=p.minutesSource,body=p.minutesFrom&&p.minutesTo?{from:p.minutesFrom,to:p.minutesTo}:{};
      if(action==='minutes-run-retry'){const run=(p.minutesData?.runs||s.minutes.runs||[]).find(r=>r.id===id);if(!run)throw new Error('同步记录已更新，请刷新后重试');sourceId=run.source_id;body=run.from_time.startsWith('1970-')?{}:{from:shortDay(run.from_time),to:shortDay(new Date(Date.parse(run.to_time)-1).toISOString())};}
      if(!sourceId)throw new Error('请先选择听记账号');el.disabled=true;try{const result=await api(`/minutes/sources/${sourceId}/range`,{method:'POST',body});toast(result.message);await reloadPage();await refreshList(p.minutesData?.page||1);}finally{el.disabled=false;}return true;
    }
    if(action==='minutes-play'){await showRecord(id);return click('minutes-audio',id,el);}
    if(action==='minutes-detail'){await showRecord(id,el.dataset.context||'');return true;}
    if(action==='minutes-context'){await showContext(new URLSearchParams({[el.dataset.kind+'_id']:id}).toString());return true;}
    if(action==='minutes-context-page'){await showContext(el.dataset.context,Number(id));return true;}
    if(action==='minutes-list-refresh'){await reloadPage();await refreshList();return true;}
    if(action==='minutes-page'){await refreshList(Number(id));return true;}
    if(action==='minutes-audio'){
      const identity=simulationIdentity(),response=await fetch(`${basePath}api/minutes/records/${id}/audio${currentContext?'?'+currentContext:''}`,{credentials:'same-origin',headers:identity?{'X-CRM-Act-As':identity}:{}});
      if(!response.ok){const e=await response.json();throw new Error(e.error||'录音读取失败');}releaseAudio();audioUrl=URL.createObjectURL(await response.blob());document.querySelector('#minutes-player').innerHTML=`<audio controls preload="metadata" src="${audioUrl}"></audio>`;return true;
    }
    const route={start:'/minutes/start',cancel:`/minutes/authorizations/${id}/cancel`,disconnect:`/minutes/sources/${id}/disconnect`,sync:`/minutes/sources/${id}/sync`,history:`/minutes/sources/${id}/history`,refresh:`/minutes/records/${id}/refresh`}[action.slice(8)];
    if(route){el.disabled=true;try{const r=await api(route,{method:'POST',body:action==='minutes-refresh'?Object.fromEntries(Object.entries(queryContext(currentContext)).map(([k,v])=>[k,Number(v)])):{}});toast(r.message);if(action==='minutes-refresh')await showRecord(id,currentContext);else await reloadPage();}finally{el.disabled=false;}return true;}
    return true;
  }
  async function submit(form){
    const type=form.dataset.form;if(!type.startsWith('minutes-'))return false;const b=Object.fromEntries(new FormData(form)),submit=form.querySelector('[type=submit]');if(submit)submit.disabled=true;
    try{
      if(type==='minutes-filter'){const p=getP();p.minutesQ=b.q||'';p.minutesSource=b.source_id||'';if(!!p.minutesFrom!==!!p.minutesTo)throw new Error('请同时选择开始和结束日期');await refreshList();return true;}
      let r;
      if(type==='minutes-start')r=await api('/minutes/start',{method:'POST',body:{account_mode:b.account_mode}});
      if(type==='minutes-profile')r=await api(`/minutes/authorizations/${form.dataset.id}/retry`,{method:'POST',body:{profile:b.profile}});
      if(type==='minutes-confirm')r=await api(`/minutes/authorizations/${form.dataset.id}/confirm`,{method:'POST',body:{accepted:b.accepted==='on'}});
      if(type==='minutes-association')r=await api(`/minutes/records/${form.dataset.id}/association`,{method:'POST',body:{revision:currentRecord.revision,customer_id:b.customer_id?Number(b.customer_id):null,opportunity_id:b.opportunity_id?Number(b.opportunity_id):null,reason:b.reason}});
      toast(r.message);await reloadPage();if(type==='minutes-association')await showRecord(form.dataset.id,'');return true;
    }catch(e){form.querySelector('.form-error')?.replaceChildren(document.createTextNode(e.message));throw e;}finally{if(submit)submit.disabled=false;}
  }
  const timer=setInterval(async()=>{
    const S=getS(),historyRunning=S?.minutes?.sources?.some(s=>s.history?.status==='running'),updating=S?.minutes?.sources?.some(s=>s.schedule?.state==='running');
    if(polling||document.hidden||!document.querySelector('#minutes-records')||!historyRunning&&!updating&&(!S?.minutes?.automatic||Date.now()-lastPoll<30000))return;
    polling=true;lastPoll=Date.now();try{const before=JSON.stringify(S.minutes?.sources),m=await api('/minutes/connections');if(getS()===S&&document.querySelector('#minutes-records')){const restore=saveDrafts();Object.assign(S.minutes,m);if(historyRunning||updating||before!==JSON.stringify(m.sources))await refreshList(getP().minutesData?.page||1);restore();}}catch{}finally{polling=false;}
  },2500);
  document.querySelector('#dialog')?.addEventListener('close',closeDetail);
  document.addEventListener('change',e=>{if(e.target.closest('form[data-form="minutes-filter"]')){if(e.target.name==='source_id'){getP().minutesSource=e.target.value;void refreshList().catch(err=>toast(err.message,true));}return;}if(e.target.name==='minutes_page_size'){getP().minutesPageSize=Number(e.target.value);void refreshList().catch(err=>toast(err.message,true));return;}const form=e.target.closest('form[data-form="minutes-association"]');if(!form)return;const S=getS();if(e.target.name==='opportunity_id'&&e.target.value){const o=S.opportunities.find(o=>o.id===Number(e.target.value));if(o)form.elements.customer_id.value=String(o.customer_id);}if(e.target.name==='customer_id'&&form.elements.opportunity_id.value){const o=S.opportunities.find(o=>o.id===Number(form.elements.opportunity_id.value));if(o&&o.customer_id!==Number(e.target.value))form.elements.opportunity_id.value='';}});
  window.addEventListener('hashchange',()=>{closeDetail();beforeRender();});window.addEventListener('pagehide',()=>{closeDetail();beforeRender();clearInterval(timer);});
  return {click,submit,beforeRender,mountFilters};
}
