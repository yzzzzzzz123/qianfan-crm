import {esc,plainMoney} from '../ui.js';

const normalize=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{Cf}]/gu,'');
const companyStem=value=>normalize(value).replace(/有限责任公司|股份有限公司|有限公司|集团|公司/g,'');
const amount=value=>Number.isSafeInteger(value)?plainMoney(value):'待核对';
const transfers=new WeakMap();

export function mountCustomerForm(form,S,{api}={}){
  if(!form)return;
  if(form.dataset.form==='customer'){
    const box=form.querySelector('#duplicate-hints'),ack=form.querySelector('[data-duplicate-ack]');
    if(!box)return;
    const refresh=()=>{
      const name=form.elements.name.value,credit=form.elements.credit_code?.value||'',norm=normalize(name),code=normalize(credit);
      const stem=companyStem(name);
      const matches=(S.customers||[]).filter(c=>norm.length>1&&(normalize(c.name)===norm||normalize(c.short_name)===norm||stem.length>1&&(companyStem(c.name).includes(stem)||stem.includes(companyStem(c.name))))||code&&c.credit_code&&normalize(c.credit_code)===code).slice(0,5);
      const exact=matches.some(c=>normalize(c.name)===norm||code&&c.credit_code&&normalize(c.credit_code)===code);
      box.innerHTML=matches.length?`<div class="customer-duplicate-notice" role="status"><strong>${exact?'已有相同主体档案，请先查看':'找到疑似客户，请核对是否为同一企业'}</strong>${matches.map(c=>`<div><span>${esc(c.name)}<small>${esc(c.owner_id?S.users.find(u=>u.id===c.owner_id)?.name||'负责人待核对':'负责人待核对')}</small></span><button type="button" class="btn ghost" data-action="customer-duplicate-open" data-id="${c.id}">打开档案</button></div>`).join('')}</div>`:'';
      if(ack){ack.hidden=!matches.length||exact;const check=ack.querySelector('input');if(check){check.checked=false;check.disabled=ack.hidden;}}
    };
    for(const name of ['name','credit_code'])form.elements[name]?.addEventListener('input',refresh);
    refresh();
  }
  if(form.dataset.form==='customer-transfer'){
    const state={api,seq:0,preview:null};transfers.set(form,state);
    const refresh=()=>refreshCustomerTransfer(form);
    form.elements.owner_id.addEventListener('change',refresh);
    form.elements.ownership_scope.addEventListener('change',()=>renderTransfer(form,state));
    void refresh();
  }
}

function renderTransfer(form,state){
  const data=state.preview,box=form.querySelector('#customer-transfer-preview'),linked=form.elements.ownership_scope.value==='linked_records';
  const confirm=form.elements.ownership_confirmed||form.elements.confirmed;
  if(confirm){confirm.checked=false;confirm.required=linked;confirm.disabled=!linked;confirm.closest('label').hidden=!linked;}
  const submit=form.querySelector('[type="submit"]');
  if(!data){submit.disabled=true;return;}
  form.elements.transfer_preview_token.value=data.preview_token;
  const totals=data.totals||{};
  box.innerHTML=`<div class="customer-transfer-summary"><strong>${linked?'同步调整既有业务归属':'仅交接客户后续维护'}</strong><p>${linked?'以下原负责人名下的商机和合同将随客户移交，相关回款及实时提成归属也会更新。':'联系人及客户资料交由新负责人维护。既有商机、合同、回款和业绩归属保持原负责人。'}</p><div class="customer-transfer-metrics"><span>关联商机 <b>${totals.opportunities??0}</b></span><span>关联合同 <b>${totals.contracts??0}</b></span><span>合同金额 <b>${amount(totals.contract_amount)}</b></span><span>实际到账 <b>${amount(totals.collected)}</b></span></div>${(data.contracts||[]).length?`<details><summary>查看受影响合同及归属限制</summary>${data.contracts.map(c=>`<div class="customer-transfer-contract"><span>${esc(c.name||c.contract_no||'合同 #'+c.id)}</span><span>${amount(c.amount)}${c.locked?` · ${esc(c.lock_message||'历史归属已锁定')}`:''}</span></div>`).join('')}</details>`:''}${linked&&!data.can_transfer_linked?'<p class="form-error">部分合同历史归属已锁定，请保留既有业务归属，或先处理相关历史记录。</p>':''}<button type="button" class="btn ghost" data-action="customer-transfer-refresh">重新读取影响范围</button></div>`;
  submit.disabled=linked&&!data.can_transfer_linked;
}

export async function refreshCustomerTransfer(form){
  const state=transfers.get(form);if(!state)return;
  const sequence=++state.seq,target=form.elements.owner_id.value,box=form.querySelector('#customer-transfer-preview');
  state.preview=null;form.elements.transfer_preview_token.value='';renderTransfer(form,state);
  if(!target||target===form.dataset.previousOwner){box.innerHTML='<p class="muted">请选择新的客户负责人后查看移交范围。</p>';return;}
  box.innerHTML='<p class="muted" role="status">正在读取移交影响…</p>';
  try{
    const data=await state.api('/customers/'+form.dataset.id+'/transfer-preview?'+new URLSearchParams({owner_id:target}));
    if(sequence!==state.seq||!form.isConnected)return;
    state.preview=data;renderTransfer(form,state);
  }catch(error){
    if(sequence!==state.seq||!form.isConnected)return;
    box.innerHTML=`<p class="form-error" role="alert">${esc(error.message)}</p><button type="button" class="btn secondary" data-action="customer-transfer-refresh">重试读取</button>`;
  }
}

export function customerEditPayload(S,type,id,values){
  const body={...values};
  if(type==='customer-transfer')return {owner_id:Number(body.owner_id),reason:body.reason,ownership_scope:body.ownership_scope,ownership_confirmed:(body.ownership_confirmed||body.confirmed)==='on',transfer_preview_token:body.transfer_preview_token};
  const original=type==='edit-customer'?S.customers.find(c=>c.id===id):S.contacts.find(p=>p.id===id);
  if(type==='edit-customer'){delete body.owner_id;delete body.reason;}
  if(original){
    for(const key of Object.keys(body)){
      const before=key==='active'?String(!original.archived_at):key==='management_status'?original.management_status||(['冻结','流失'].includes(original.status)?original.status:'正常'):String(original[key]??'');
      if(String(body[key])===before)delete body[key];
    }
  }
  return body;
}
