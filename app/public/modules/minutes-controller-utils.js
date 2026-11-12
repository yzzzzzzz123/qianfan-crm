import {esc,actionButton as button} from '../ui.js';

// Notify the enhanced select without firing a second document-level change.
export function setMinutesSelect(select,value) {
  if(!select)return;
  select.value=String(value??'');
  select.dispatchEvent(new Event('change'));
}

export function mountMinutesAssociation(form,S,record) {
  if(!form)return;
  form.dataset.revision=String(record.revision);
  const customer=form.elements.customer_id,opportunity=form.elements.opportunity_id;
  for(const [select,id,label]of [[customer,record.customer_id,'原关联客户已移交，请管理员核对'],[opportunity,record.opportunity_id,'原关联商机已移交或归档，请管理员核对']]){
    if(id&&![...select.options].some(o=>String(o.value)===String(id))){const option=document.createElement('option');option.value=String(id);option.textContent=label;select.append(option);}
    setMinutesSelect(select,id||'');
  }
  const choices=()=>{
    const selected=opportunity.value,rows=S.opportunities.filter(o=>!customer.value||String(o.customer_id)===customer.value);
    opportunity.replaceChildren();
    const option=(value,label,disabled=false)=>{const el=document.createElement('option');el.value=String(value);el.textContent=label;el.disabled=disabled;opportunity.append(el);};
    option('','不指定商机');
    for(const o of rows)option(o.id,(S.customers.find(c=>c.id===o.customer_id)?.name||'')+' · '+o.name);
    if(selected&&!S.opportunities.some(o=>String(o.id)===selected))option(selected,'原关联商机已移交或归档，请管理员核对');
    setMinutesSelect(opportunity,[...opportunity.options].some(o=>o.value===selected)?selected:'');
  };
  const preview=()=>{
    const target=form.querySelector('[data-minutes-association-preview]');if(!target)return;
    const c=S.customers.find(c=>String(c.id)===customer.value),o=S.opportunities.find(o=>String(o.id)===opportunity.value);
    target.textContent=opportunity.value?`保存后关联：${c?.name||'原关联客户'} / ${o?.name||'原关联商机'}`:customer.value?`保存后仅关联客户：${c?.name||'原关联客户'}，不会生成商机跟进摘要。`:'保存后取消业务关联，并撤下原商机中的自动摘要。';
  };
  choices();preview();
  form.addEventListener('change',e=>{
    if(e.target===customer){
      const selected=S.opportunities.find(o=>String(o.id)===opportunity.value);
      if(!customer.value||!selected||String(selected.customer_id)!==customer.value)setMinutesSelect(opportunity,'');
      choices();
    }
    if(e.target===opportunity&&opportunity.value){
      const o=S.opportunities.find(o=>String(o.id)===opportunity.value);
      if(o){setMinutesSelect(customer,o.customer_id);choices();}
    }
    preview();
  });
}

export const minutesFilterFields={q:'minutesQ',source_id:'minutesSource',customer_id:'minutesCustomer',opportunity_id:'minutesOpportunity',link_state:'minutesLinkState',content_state:'minutesContentState',media_state:'minutesMediaState',page_size:'minutesPageSize'};
export const minutesFilterKey=p=>JSON.stringify(Object.values(minutesFilterFields).map(key=>p[key]??''));
export function minutesFilterQuery(p,page=1) {
  const q=new URLSearchParams({page:String(page),page_size:String(p.minutesPageSize||10)});
  for(const [name,key]of Object.entries(minutesFilterFields))if(p[key]&&name!=='page_size')q.set(name,p[key]);
  if(p.minutesFrom)q.set('from',p.minutesFrom);if(p.minutesTo)q.set('to',p.minutesTo);
  return q;
}

export function createMinutesAudioPlayer({getRecord,getEpoch,getContext,getActor,getPlayer,fetcher=fetch,getIdentity=()=>'',basePath='/',onError=()=>{},createUrl=blob=>URL.createObjectURL(blob),revokeUrl=url=>URL.revokeObjectURL(url)}) {
  let controller=null,url=null,serial=0,playerNode=null;
  const clear=()=>{
    serial++;controller?.abort();controller=null;
    const audio=playerNode?.querySelector?.('audio');
    if(audio){audio.pause();audio.removeAttribute('src');audio.load();}
    playerNode=null;if(url){revokeUrl(url);url=null;}
  };
  async function play(id) {
    if(String(getRecord()?.id)!==String(id))return;
    clear();const request=serial,epoch=getEpoch(),context=getContext(),actor=getActor(),abort=new AbortController();controller=abort;
    const active=()=>request===serial&&epoch===getEpoch()&&context===getContext()&&actor===getActor()&&String(getRecord()?.id)===String(id)&&!!getPlayer();
    playerNode=getPlayer();if(playerNode)playerNode.innerHTML='<p class="minutes-hint" role="status">正在读取本条录音…</p>';
    try {
      const identity=getIdentity(),response=await fetcher(`${basePath}api/minutes/records/${id}/audio${context?'?'+context:''}`,{credentials:'same-origin',signal:abort.signal,headers:identity?{'X-CRM-Act-As':identity}:{}});
      if(!response.ok){const error=await response.json();throw new Error(error.error||'录音读取失败');}
      if(!active())return;
      const blob=await response.blob();if(!active())return;
      url=createUrl(blob);getPlayer().innerHTML=`<audio controls preload="metadata" src="${esc(url)}"></audio>`;
    }catch(error){
      if(error.name==='AbortError'||!active())return;
      getPlayer().innerHTML=`<p class="minutes-hint">${esc(error.message)}</p>${button('重试录音','minutes-audio',id,'secondary','refresh')}`;onError(error);
    }finally{if(controller===abort)controller=null;}
  }
  return {play,clear,isLoading:()=>!!controller};
}
