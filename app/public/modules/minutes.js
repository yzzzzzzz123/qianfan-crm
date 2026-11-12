import {esc,icon,badge,empty,actionButton as button} from '../ui.js';
import {api,basePath,simulationIdentity} from '../api.js';
import {minuteArtifact} from './minutes-artifacts.js';
import {minutesDetailView} from './minutes-detail-view.js';
import {minutesPage,listTable} from './minutes-workspace.js';
import {mountMinutesAssociation,setMinutesSelect,minutesFilterFields,minutesFilterKey,minutesFilterQuery,createMinutesAudioPlayer} from './minutes-controller-utils.js';
import {bindCommittedSearch} from './search-input.js';
export {minutesPage} from './minutes-workspace.js';

const date=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value)):'尚未采集';
const duration=ms=>`${Math.floor(ms/60000)} 分 ${Math.floor(ms/1000)%60} 秒`;
function dateProblem(p,today){
  if(!!p.minutesFrom!==!!p.minutesTo)return p.minutesFrom?'请选择结束日期以应用筛选':'请选择开始日期以应用筛选';
  if(p.minutesFrom&&p.minutesTo&&p.minutesFrom>p.minutesTo)return '开始日期不能晚于结束日期';
  if(p.minutesTo&&p.minutesTo>today)return '听记日期不能晚于今天';
  return '';
}

export function linkedMinutes(kind,id){return `<section class="detail-section"><h3>钉钉听记</h3><p class="muted">查看明确关联到此${kind==='customer'?'客户':'商机'}的听记、总结与录音。</p><button class="btn secondary" data-action="minutes-context" data-id="${id}" data-kind="${kind}">查看关联听记 ${icon('chevron')}</button></section>`;}
const queryContext=text=>Object.fromEntries(new URLSearchParams(text||''));
export function createMinutesController({getS,getP,openHtml,content,reload,toast}){
  const autoArtifacts=new Set();
  let currentRecord=null,currentContext='',contextPage=1,polling=false,lastPoll=0,detailTab='summary',speakerTimer=null,speakerPolls=0,detailEpoch=0,listEpoch=0,calendarEpoch=0,calendarHandle=null,searchTimer=null,connectionKey='',mountedState=null;
  const audioPlayer=createMinutesAudioPlayer({getRecord:()=>currentRecord,getEpoch:()=>detailEpoch,getContext:()=>currentContext,getActor:()=>getS()?.actor.id,getPlayer:()=>document.querySelector('#dialog[open] #minutes-player'),getIdentity:simulationIdentity,basePath,onError:error=>toast(error.message,true)});
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
        p.minutesFrom=dates[0]||'';p.minutesTo=dates[1]||'';p.minutesRunPage=1;void refreshList().catch(err=>toast(err.message,true));
      }});
      if(mountedState!==getS()){
        mountedState=getS();
        if(p.minutesData||Object.values(minutesFilterFields).some(key=>!!p[key])||p.minutesFrom||p.minutesTo||p.minutesTab==='runs')await refreshList(p.minutesData?.page||1);
      }
    }catch(e){if(epoch===calendarEpoch)toast('日期筛选组件加载失败，请刷新页面重试',true);}
  }
  function renderList(){
    const root=document.querySelector('#minutes-records');if(!root){content();return;}
    const template=document.createElement('template');template.innerHTML=minutesPage(getS(),getP());
    root.querySelector('.minutes-totals')?.replaceWith(template.content.querySelector('.minutes-totals'));
    const connections=template.content.querySelector('[data-minutes-connections]'),signature=JSON.stringify([getS().minutes?.sources,getS().minutes?.authorization,getS().minutes?.coverage]);
    if(connections&&signature!==connectionKey){
      const previous=root.querySelector('[data-minutes-connections]'),checked=previous?.querySelector('[name="accepted"]')?.checked,mode=previous?.querySelector('[name="account_mode"]')?.value;
      if(previous)connections.open=previous.open;
      previous?.replaceWith(connections);connectionKey=signature;
      if(checked&&connections.querySelector('[name="accepted"]'))connections.querySelector('[name="accepted"]').checked=true;
      if(mode)setMinutesSelect(connections.querySelector('[name="account_mode"]'),mode);
    }
    const panel=root.querySelector('.minutes-content'),next=template.content.querySelector('.minutes-content');
    // Keep the actual date inputs mounted while asynchronous results change.
    for(const child of [...panel.children])if(!child.matches('.minutes-tools'))child.remove();
    for(const child of [...next.children])if(!child.matches('.minutes-tools'))panel.append(child);
    const heading=panel.querySelector('.minutes-workspace-title');if(heading)panel.insertBefore(heading,panel.querySelector('.minutes-tools'));
    syncFilterControls();
    updateDateControls();
  }
  function syncFilterControls(){
    const form=document.querySelector('form[data-form="minutes-filter"]');if(!form)return;
    for(const [name,key]of Object.entries(minutesFilterFields)){
      const field=form.elements[name];if(!field)continue;
      if(['q','customer_id','opportunity_id','link_state','content_state','media_state'].includes(name))field.closest('label').hidden=getP().minutesTab==='runs';
      const value=getP()[key]||(name==='page_size'?10:name.endsWith('_state')?'all':'');
      if(field.tagName==='SELECT')setMinutesSelect(field,value);else if(field!==document.activeElement)field.value=value;
    }
    const opportunity=form.elements.opportunity_id,customer=form.elements.customer_id;
    if(opportunity&&customer){
      opportunity.innerHTML='<option value="">全部商机</option>'+getS().opportunities.filter(o=>!customer.value||String(o.customer_id)===customer.value).map(o=>`<option value="${o.id}">${esc(o.name)}</option>`).join('');
      setMinutesSelect(opportunity,getP().minutesOpportunity||'');
    }
    setMinutesSelect(document.querySelector('.minutes-run-tools [name="run_status"]'),getP().minutesRunStatus||'all');
    const sizeLabel=form.elements.page_size?.closest('label'),sizeText=sizeLabel&&[...sizeLabel.childNodes].find(node=>node.nodeType===3);
    if(sizeText)sizeText.textContent=getP().minutesTab==='runs'?'每页任务':'每页听记';
    const toggle=form.querySelector('[data-action="minutes-filter-toggle"]');
    if(toggle){
      toggle.hidden=getP().minutesTab==='runs';toggle.setAttribute('aria-expanded',String(!!getP().minutesFiltersOpen));
      const count=['minutesCustomer','minutesOpportunity','minutesLinkState','minutesContentState','minutesMediaState'].filter(key=>getP()[key]&&getP()[key]!=='all').length,counter=toggle.querySelector('[data-minutes-advanced-count]');
      if(counter){counter.textContent=`已选 ${count} 项`;counter.hidden=!count;}
    }
  }
  function saveDrafts(){
    const fields=[...document.querySelectorAll('form[data-form="minutes-filter"] input,form[data-form="minutes-filter"] select')].filter(el=>el.name).map(el=>({form:el.form.dataset.form,name:el.name,value:el.value,focused:el===document.activeElement,start:el.selectionStart,end:el.selectionEnd}));
    return ()=>{for(const f of fields){const el=document.querySelector(`form[data-form="${f.form}"] [name="${f.name}"]`);if(!el)continue;el.value=f.value;if(f.focused){el.focus({preventScroll:true});if(f.start!==null&&f.start!==undefined&&['text','search'].includes(el.type))el.setSelectionRange(f.start,f.end);}}};
  }
  const releaseAudio=()=>audioPlayer.clear();
  const stopSpeakerPolling=()=>{clearTimeout(speakerTimer);speakerTimer=null;};
  const closeDetail=()=>{detailEpoch++;currentRecord=null;stopSpeakerPolling();releaseAudio();};
  const speakerBody=generate=>({generate,...Object.fromEntries(Object.entries(queryContext(currentContext)).map(([k,v])=>[k,Number(v)]))});
  async function refreshArtifacts(id,context,epoch){
    const r=await api(`/minutes/records/${id}${context?'?'+context:''}`);
    if(epoch!==detailEpoch||currentRecord?.id!==r.id||!document.querySelector('#dialog')?.open)return;
    currentRecord=r;
    for(const kind of ['summary','transcript','speaker_insights','quality']){
      const section=document.querySelector(`[data-minute-artifact="${kind}"]`);
      if(section)section.outerHTML=minuteArtifact(kind,r.artifacts[kind],r.id,r.can_refresh??r.can_manage,detailTab,r.artifacts.summary);
    }
    const player=document.querySelector('#minutes-player');
    if(player&&!player.querySelector('audio')&&!audioPlayer.isLoading())player.innerHTML=r.media_state==='available'&&(r.can_refresh??r.can_manage)?button('回放录音','minutes-audio',r.id,'secondary','activities'):r.media_state==='failed'&&(r.can_refresh??r.can_manage)?button('重新检查录音','minutes-refresh',r.id,'secondary','refresh'):'';
    pollSpeaker();
  }
  function pollSpeaker(){
    stopSpeakerPolling();
    if(currentRecord?.artifacts?.speaker_insights?.state!=='pending'||!(currentRecord.can_refresh??currentRecord.can_manage)||detailTab!=='speaker_insights'||speakerPolls>=20||!document.querySelector('#dialog')?.open)return;
    const id=currentRecord.id,context=currentContext,epoch=detailEpoch;
    speakerTimer=setTimeout(async()=>{
      if(document.hidden){pollSpeaker();return;}
      try{
        speakerPolls++;await api(`/minutes/records/${id}/speaker-insights`,{method:'POST',body:speakerBody(false)});
        if(epoch===detailEpoch&&currentRecord?.id===id&&detailTab==='speaker_insights'&&document.querySelector('#dialog')?.open)await refreshArtifacts(id,context,epoch);
      }catch(e){if(epoch===detailEpoch)toast(e.message,true);}
    },5000);
  }
  async function ensureArtifact(force=false){
    const kind=detailTab,r=currentRecord,epoch=detailEpoch,context=currentContext;
    if(!(r?.can_refresh??r?.can_manage)||!['speaker_insights','quality','transcript'].includes(kind)||!document.querySelector('#dialog')?.open)return;
    const artifact=r.artifacts[kind],placeholder=!artifact||artifact.state==='unavailable'&&(!artifact.reason||/未自动创建源平台分析任务|接口尚未核验|接入未提供会议质检接口|尚未核验/.test(artifact.reason));
    if(!force&&!placeholder&&!(artifact?.state==='pending'&&kind!=='speaker_insights'))return;
    const key=`${epoch}:${kind}`;if(autoArtifacts.has(key)&&!force)return;autoArtifacts.add(key);
    const paint=a=>{if(epoch!==detailEpoch||currentRecord?.id!==r.id)return;currentRecord.artifacts[kind]=a;const section=document.querySelector(`[data-minute-artifact="${kind}"]`);if(section)section.outerHTML=minuteArtifact(kind,a,r.id,true,detailTab,r.artifacts.summary);};
    paint({state:'pending',content:r.artifacts[kind]?.content||'',reason:kind==='quality'?'正在分析会议正文…':kind==='transcript'?'正在读取钉钉逐字稿…':'正在读取钉钉发言人观点…'});
    try{
      await api(`/minutes/records/${r.id}/${kind==='speaker_insights'?'speaker-insights':kind}`,{method:'POST',body:kind!=='speaker_insights'?Object.fromEntries(Object.entries(queryContext(context)).map(([k,v])=>[k,Number(v)])):speakerBody(true)});
      if(epoch===detailEpoch&&document.querySelector('#dialog')?.open)await refreshArtifacts(r.id,context,epoch);
    }catch(e){paint({state:'failed',content:r.artifacts[kind]?.content||'',reason:e.message});}
  }
  async function refreshList(page=1){
    const p=getP(),epoch=++listEpoch,actor=getS()?.actor?.id;updateDateControls();if(dateError(p))return;
    const key=minutesFilterKey(p)+JSON.stringify([p.minutesFrom,p.minutesTo,p.minutesRunStatus,p.minutesTab]),current=()=>epoch===listEpoch&&getP()===p&&getS()?.actor?.id===actor&&minutesFilterKey(p)+JSON.stringify([p.minutesFrom,p.minutesTo,p.minutesRunStatus,p.minutesTab])===key;
    const q=minutesFilterQuery(p,page),runsQuery=new URLSearchParams({page:String(p.minutesRunPage||1),page_size:String(p.minutesPageSize||10)});
    if(p.minutesSource)runsQuery.set('source_id',p.minutesSource);if(p.minutesRunStatus)runsQuery.set('status',p.minutesRunStatus);if(p.minutesFrom)runsQuery.set('from',p.minutesFrom);if(p.minutesTo)runsQuery.set('to',p.minutesTo);
    try{
      const [result,runs]=await Promise.all([api('/minutes?'+q),p.minutesTab==='runs'?api('/minutes/runs?'+runsQuery):null]);
      if(current()){p.minutesData=result;if(runs)p.minutesRunsData=runs;renderList();}
    }catch(e){if(current())throw e;}
  }
  async function reloadPage(){const page=getP().minutesData?.page||1,connectionOpen=document.querySelector('[data-minutes-connections]')?.open;await reload();if(connectionOpen!==undefined&&document.querySelector('[data-minutes-connections]'))document.querySelector('[data-minutes-connections]').open=connectionOpen;if(getP().view==='minutes')await refreshList(page);}
  async function showContext(context,page=1){closeDetail();currentContext=context;contextPage=page;const q=new URLSearchParams(context);q.set('page',page);const d=await api('/minutes?'+q);openHtml(`<header class="dialog-head"><h2>关联钉钉听记</h2><button class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="drawer-body">${listTable(d,context)}<div class="table-footer">共 ${d.count} 条 · 第 ${d.page} 页<div>${d.page>1?`<button class="btn ghost" data-action="minutes-context-page" data-id="${d.page-1}" data-context="${esc(context)}">上一页</button>`:''}${d.page*(d.page_size||10)<d.count?`<button class="btn ghost" data-action="minutes-context-page" data-id="${d.page+1}" data-context="${esc(context)}">下一页</button>`:''}</div></div></div>`,true);}
  async function showRecord(id,context='',selectedTab='summary',continuing=false){
    stopSpeakerPolling();if(!continuing){detailEpoch++;speakerPolls=0;autoArtifacts.clear();}const epoch=detailEpoch;
    releaseAudio();const S=getS(),r=await api(`/minutes/records/${id}${context?'?'+context:''}`);if(epoch!==detailEpoch)return;currentRecord=r;currentContext=context;
    detailTab=selectedTab;
    openHtml(minutesDetailView(S,r,context,detailTab),false);
    document.querySelector('#dialog')?.classList.add('minutes-dialog');
    mountMinutesAssociation(document.querySelector('form[data-form="minutes-association"]'),S,r);
    pollSpeaker();void ensureArtifact();
  }

  async function click(action,id,el){
    if(!action.startsWith('minutes-'))return false;
    if(action==='minutes-tab'){getP().minutesTab=id;await refreshList(getP().minutesData?.page||1);return true;}
    if(action==='minutes-view'){
      const p=getP();p.minutesLinkState=id==='unlinked'?'unlinked':'';p.minutesContentState=id==='content-pending'?'pending':id==='content-failed'?'failed':'';
      p.minutesTab='notes';p.minutesRunPage=1;await refreshList();return true;
    }
    if(action==='minutes-filter-toggle'){
      const p=getP();p.minutesFiltersOpen=!p.minutesFiltersOpen;document.querySelector('#minutes-records')?.classList.toggle('minutes-filters-open',p.minutesFiltersOpen);syncFilterControls();return true;
    }
    if(action==='minutes-reset'){
      const p=getP();for(const key of Object.values(minutesFilterFields))p[key]='';p.minutesFrom='';p.minutesTo='';p.minutesRunStatus='';p.minutesRunPage=1;p.minutesPageSize=10;p.minutesData=null;p.minutesRunsData=null;
      content();await refreshList();return true;
    }
    if(action==='minutes-run-page'){getP().minutesRunPage=Number(id)||1;await refreshList(getP().minutesData?.page||1);return true;}
    if(action==='minutes-association-toggle'){const form=document.querySelector('[data-form="minutes-association"]');if(form){form.hidden=!form.hidden;if(!form.hidden)stopSpeakerPolling();else pollSpeaker();}return true;}
    if(action==='minutes-detail-tab'){detailTab=id;document.querySelectorAll('[data-minute-artifact]').forEach(section=>section.hidden=section.dataset.minuteArtifact!==id);document.querySelectorAll('[data-action="minutes-detail-tab"]').forEach(b=>{b.classList.toggle('active',b.dataset.id===id);b.setAttribute('aria-selected',String(b.dataset.id===id));});pollSpeaker();void ensureArtifact();return true;}

    if(action==='minutes-range-sync'||action==='minutes-run-retry'){
      const p=getP(),sourceId=id||p.minutesSource;
      if(action==='minutes-range-sync'&&(!sourceId||!p.minutesFrom||!p.minutesTo))throw new Error('请先选择听记账号和完整日期范围');
      const path=action==='minutes-run-retry'?`/minutes/runs/${id}/retry`:`/minutes/sources/${sourceId}/range`;
      el.disabled=true;try{const result=await api(path,{method:'POST',body:action==='minutes-run-retry'?{}:{from:p.minutesFrom,to:p.minutesTo}});toast(result.message);await reloadPage();}finally{el.disabled=false;}return true;
    }
    if(action==='minutes-play'){await showRecord(id,el.dataset.context||'');if(!(currentRecord?.can_refresh??currentRecord?.can_manage))return true;return click('minutes-audio',id,el);}
    if(action==='minutes-detail'){await showRecord(id,el.dataset.context||'');return true;}
    if(action==='minutes-context'){await showContext(new URLSearchParams({[el.dataset.kind+'_id']:id}).toString());return true;}
    if(action==='minutes-context-page'){await showContext(el.dataset.context,Number(id));return true;}
    if(action==='minutes-context-back'){await showContext(el.dataset.context||currentContext,contextPage);return true;}
    if(action==='minutes-list-refresh'){await reloadPage();return true;}
    if(action==='minutes-page'){await refreshList(Number(id));return true;}
    if(action==='minutes-audio'){
      if(!(currentRecord?.can_refresh??currentRecord?.can_manage))return true;
      await audioPlayer.play(id);return true;
    }
    if(action==='minutes-artifact-retry'){
      if(!currentRecord||Number(el.dataset.recordId)!==currentRecord.id||!['summary','transcript','speaker_insights','quality'].includes(id))return true;
      if(!(currentRecord.can_refresh??currentRecord.can_manage))throw new Error('当前仅可查阅已保存内容，请先恢复有效账号连接');
      el.disabled=true;
      try{
        if(id==='summary'){const epoch=detailEpoch,recordId=currentRecord.id,context=currentContext;await api(`/minutes/records/${recordId}/refresh`,{method:'POST',body:Object.fromEntries(Object.entries(queryContext(context)).map(([k,v])=>[k,Number(v)]))});await refreshArtifacts(recordId,context,epoch);}
        else{detailTab=id;await ensureArtifact(true);}
      }finally{el.disabled=false;}return true;
    }
    if(action==='minutes-refresh'){
      const epoch=detailEpoch,context=currentContext;el.disabled=true;
      try{const result=await api(`/minutes/records/${id}/refresh`,{method:'POST',body:Object.fromEntries(Object.entries(queryContext(context)).map(([k,v])=>[k,Number(v)]))});toast(result.message);await refreshArtifacts(Number(id),context,epoch);}finally{el.disabled=false;}return true;
    }
    const route={start:'/minutes/start',cancel:`/minutes/authorizations/${id}/cancel`,disconnect:`/minutes/sources/${id}/disconnect`,sync:`/minutes/sources/${id}/sync`,history:`/minutes/sources/${id}/history`,refresh:`/minutes/records/${id}/refresh`}[action.slice(8)];
    if(route){el.disabled=true;try{const r=await api(route,{method:'POST',body:action==='minutes-refresh'?Object.fromEntries(Object.entries(queryContext(currentContext)).map(([k,v])=>[k,Number(v)])):{}});toast(r.message);if(action==='minutes-refresh')await showRecord(id,currentContext);else await reloadPage();}finally{el.disabled=false;}return true;}
    return true;
  }
  async function submit(form){
    const type=form.dataset.form;if(!type.startsWith('minutes-'))return false;const b=Object.fromEntries(new FormData(form)),submit=form.querySelector('[type=submit]');if(submit)submit.disabled=true;
    try{
      if(type==='minutes-filter'){const p=getP();for(const [name,key]of Object.entries(minutesFilterFields))if(Object.hasOwn(b,name))p[key]=name==='page_size'?Number(b[name]):b[name];p.minutesRunPage=1;if(!!p.minutesFrom!==!!p.minutesTo)throw new Error('请同时选择开始和结束日期');await refreshList();return true;}
      let r;
      if(type==='minutes-start')r=await api('/minutes/start',{method:'POST',body:{account_mode:b.account_mode}});
      if(type==='minutes-profile')r=await api(`/minutes/authorizations/${form.dataset.id}/retry`,{method:'POST',body:{profile:b.profile}});
      if(type==='minutes-confirm')r=await api(`/minutes/authorizations/${form.dataset.id}/confirm`,{method:'POST',body:{accepted:b.accepted==='on'}});
      if(type==='minutes-association')r=await api(`/minutes/records/${form.dataset.id}/association`,{method:'POST',body:{revision:Number(form.dataset.revision),customer_id:b.customer_id?Number(b.customer_id):null,opportunity_id:b.opportunity_id?Number(b.opportunity_id):null,reason:b.reason}});
      toast(r.message);await reloadPage();if(type==='minutes-association')await showRecord(form.dataset.id,'');return true;
    }catch(e){form.querySelector('.form-error')?.replaceChildren(document.createTextNode(e.message));throw e;}finally{if(submit)submit.disabled=false;}
  }
  const timer=setInterval(async()=>{
    const S=getS(),historyRunning=S?.minutes?.sources?.some(s=>s.history?.status==='running'),updating=S?.minutes?.sources?.some(s=>s.schedule?.state==='running'),authorizing=['starting','awaiting','verifying'].includes(S?.minutes?.authorization?.status),awaitingConfirmation=S?.minutes?.authorization?.status==='pending_confirmation';
    if(polling||document.hidden||!document.querySelector('#minutes-records')||!historyRunning&&!updating&&!authorizing&&(!S?.minutes?.automatic&&!awaitingConfirmation||Date.now()-lastPoll<30000))return;
    polling=true;lastPoll=Date.now();
    try{
      const before=JSON.stringify([S.minutes?.sources,S.minutes?.authorization,S.minutes?.coverage]),m=await api('/minutes/connections');
      if(getS()===S&&document.querySelector('#minutes-records')){
        const restore=saveDrafts();Object.assign(S.minutes,m);
        if(historyRunning||updating||authorizing||before!==JSON.stringify([m.sources,m.authorization,m.coverage]))await refreshList(getP().minutesData?.page||1);
        restore();syncFilterControls();
      }
    }catch{}finally{polling=false;}
  },2500);
  document.querySelector('#dialog')?.addEventListener('close',closeDetail);
  document.addEventListener('change',e=>{
    const form=e.target.closest('form[data-form="minutes-filter"]');if(!form&&e.target.name!=='run_status')return;
    const p=getP(),key=minutesFilterFields[e.target.name];
    if(key){p[key]=e.target.name==='page_size'?Number(e.target.value):e.target.value;if(e.target.name==='customer_id')p.minutesOpportunity='';}
    else if(e.target.name==='run_status')p.minutesRunStatus=e.target.value;else return;
    p.minutesRunPage=1;void refreshList().catch(err=>toast(err.message,true));
  });
  bindCommittedSearch(document,'form[data-form="minutes-filter"] [name="q"]',input=>{
    clearTimeout(searchTimer);
    const p=getP(),value=input.value;
    searchTimer=setTimeout(()=>{
      if(getP()!==p||!input.isConnected)return;
      p.minutesQ=value;
      void refreshList().catch(err=>toast(err.message,true));
    },200);
  },()=>clearTimeout(searchTimer));
  window.addEventListener('hashchange',()=>{clearTimeout(searchTimer);closeDetail();beforeRender();});window.addEventListener('pagehide',()=>{clearTimeout(searchTimer);closeDetail();beforeRender();clearInterval(timer);});
  return {click,submit,beforeRender,mountFilters,leaveDetail:closeDetail};
}
