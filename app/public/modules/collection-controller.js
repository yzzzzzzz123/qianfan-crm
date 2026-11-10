import {esc,plainMoney,dateLabel,customerName} from '../ui.js';
import {isOpenPlan,planRemaining,contractCaption} from './collection-forms.js';

const centValue=el=>!el||el.value===''?null:Math.round(Number(el.value)*100);
function required(el,on){
  if(!el)return;el.required=!!on;
  const label=el.closest('label');if(!label)return;
  const star=label.querySelector(':scope > .required');
  if(on&&!star){const span=document.createElement('span');span.className='required';span.textContent='*';label.insertBefore(span,el);}
  if(!on)star?.remove();
}
function formContext(form,S){
  const type=form.dataset.form;
  if(['payment','payment-plan-create'].includes(type))return {c:S.contracts.find(c=>c.id===Number(form.elements.contract_id?.value))};
  const c=S.contracts.find(c=>c.payments.some(p=>p.id===Number(form.dataset.id)));
  return {c,p:c?.payments.find(p=>p.id===Number(form.dataset.id))};
}
function sync(form,S){
  const type=form.dataset.form,{c,p}=formContext(form,S),status=form.elements.status?.value||'已到账';
  const paymentForm=['payment','payment-plan-create','collection-receive','payment-maintain'].includes(type);
  if(!paymentForm)return;
  if(form.elements.pay_date){const legacyUnchanged=p?.status==='已到账'&&Number(form.elements.amount?.value)===p.amount/100&&!p.pay_date;required(form.elements.pay_date,status==='已到账'&&!legacyUnchanged);}
  if(form.elements.promise_date)required(form.elements.promise_date,status!=='已到账'&&!(p&&Number(form.elements.amount?.value)===p.amount/100&&!p.promise_date));
  const context=form.querySelector('#payment-contract-context');
  if(context)context.innerHTML=c?`<strong>${esc(c.contract_no||c.code)} · ${esc(customerName(S,c.customer_id))}</strong><span>${esc(c.name)} · 合同 ${plainMoney(c.amount)} · 已收 ${plainMoney(c.collected)} · 未收 ${plainMoney(c.outstanding)}</span>`:'请选择合同后查看可收余额。';
  if(c&&form.dataset.selectedContract!==String(c.id)){
    form.dataset.selectedContract=String(c.id);
    const plan=form.elements.plan_id;if(plan){const selected=plan.value;plan.innerHTML='<option value="">自动匹配未核销计划（按预计日期）</option>'+c.payments.filter(isOpenPlan).map(p=>`<option value="${p.id}">计划 #${p.id} · 余款 ${plainMoney(planRemaining(p))} · ${dateLabel(p.promise_date)}</option>`).join('');if([...plan.options].some(o=>o.value===selected))plan.value=selected;}
  }
  const amount=centValue(form.elements.amount),product=form.elements.product_amount;
  if(form.elements.remaining_promise_date)required(form.elements.remaining_promise_date,amount>0&&p&&amount<planRemaining(p));
  if(c&&product&&status==='已到账'){
    const pure=c.product_amount!=null&&c.service_amount!=null&&(c.product_amount===0||c.service_amount===0);
    product.readOnly=pure;
    if(pure)product.value=amount==null?'':c.product_amount===0?'0':String(amount/100);
  }
  const productAmount=centValue(product),service=form.querySelector('[data-service-amount]');
  if(service)service.value=amount==null||productAmount==null?'待核对':((amount-productAmount)/100).toLocaleString('zh-CN',{maximumFractionDigits:2});
  const preview=form.querySelector('[data-receipt-preview]');
  if(preview){
    if(!c||amount==null||!Number.isFinite(amount))preview.textContent='填写本次实际到账金额后，查看实收与余款计划的变化。';
    else{
      const selected=p||c.payments.find(p=>p.id===Number(form.elements.plan_id?.value)&&isOpenPlan(p));
      const planAmount=selected?planRemaining(selected):c.payments.filter(isOpenPlan).reduce((sum,p)=>sum+planRemaining(p),0),allocated=Math.min(Math.max(0,amount),planAmount);
      preview.innerHTML=amount>c.outstanding||selected&&amount>planAmount?`<p class="text-danger">本次金额超过${selected&&planAmount<c.outstanding?'所选计划余款 '+plainMoney(planAmount):'合同未收余额 '+plainMoney(c.outstanding)}，请核对回单。</p>`:`<dl><dt>本次新增实际到账</dt><dd>${plainMoney(amount)}</dd><dt>合同未收余额</dt><dd>${plainMoney(c.outstanding)} → ${plainMoney(c.outstanding-amount)}</dd><dt>${selected?'所选计划':'有效收款计划'}</dt><dd>${planAmount?`核销 ${plainMoney(allocated)}，余款 ${plainMoney(planAmount-allocated)}`:'暂无待收计划，本次只登记实收'}</dd></dl>`;
    }
  }
  const planPreview=form.querySelector('[data-plan-preview]');
  if(planPreview){const planned=c?.payments.filter(isOpenPlan).reduce((sum,p)=>sum+planRemaining(p),0)||0;planPreview.textContent=c?`未收 ${plainMoney(c.outstanding)} · 已安排 ${plainMoney(planned)} · 可新增计划 ${plainMoney(Math.max(0,c.outstanding-planned))}。计划不增加实收。`:'选择合同后查看可安排计划余额。';}
  const duplicate=form.querySelector('.duplicate-check');
  if(duplicate){
    const date=form.elements.pay_date?.value,reference=form.elements.reference_no?.value.trim()||'';
    const existing=c&&status==='已到账'&&amount>0?c.payments.find(r=>r.status==='已到账'&&!(type==='payment-maintain'&&r.id===p?.id)&&(reference&&r.reference_no===reference||r.amount===amount&&r.pay_date===date&&(!reference||!r.reference_no))):null;
    const show=!!existing||form.dataset.forceDuplicate==='true';duplicate.hidden=!show;
    const check=form.elements.duplicate_confirmed,reason=form.elements.duplicate_reason;
    for(const input of [check,reason])if(input)input.disabled=!show;
    if(check){check.required=show;if(!show)check.checked=false;}
    required(reason,show);
    if(show)duplicate.querySelector('.duplicate-description').textContent=existing?`发现疑似重复收款 #${existing.id}：${dateLabel(existing.pay_date)} · ${plainMoney(existing.amount)}。请核对凭证，确为另一笔款项时再确认。`:form.dataset.duplicateMessage||'发现疑似重复到账，请核对后填写继续登记依据。';
  }
}

export function mountCollectionForm(form,S){
  if(!form)return;
  sync(form,S);
  const eligible=()=>S.contracts.filter(c=>c.lifecycle!=='草稿'&&(c.outstanding>0||c.outstanding==null)&&(form.dataset.form!=='payment-plan-create'||!c.terminated_at));
  form.addEventListener('input',e=>{
    const error=form.querySelector('.form-error');if(error)error.textContent='';
    if(['amount','reference_no','pay_date'].includes(e.target.name))form.dataset.forceDuplicate='false';
    if(e.target.matches('[data-contract-search]')){
      const select=form.elements.contract_id,previous=select.value,q=e.target.value.trim().toLowerCase();
      const rows=eligible().filter(c=>contractCaption(S,c).toLowerCase().includes(q));
      select.innerHTML='<option value="">请选择合同</option>'+rows.map(c=>`<option value="${c.id}">${esc(contractCaption(S,c))}</option>`).join('');
      select.value=rows.some(c=>String(c.id)===previous)?previous:'';
    }
    sync(form,S);
  });
  form.addEventListener('change',e=>{
    const error=form.querySelector('.form-error');if(error)error.textContent='';
    if(e.target.name==='contract_id')form.dataset.forceDuplicate='false';
    if(e.target.name==='decision'){
      const confirm=form.querySelector('[data-termination-confirm]');if(confirm){const needed=e.target.value==='approved';confirm.hidden=!needed;form.elements.confirmed.disabled=!needed;form.elements.confirmed.required=needed;}
    }
    sync(form,S);
  });
}
export const syncCollectionForm=sync;
export function showCollectionError(form,error){
  if(error.code!=='PAYMENT_DUPLICATE'||!form.querySelector('.duplicate-check'))return;
  form.dataset.forceDuplicate='true';form.dataset.duplicateMessage=error.message;
  const section=form.querySelector('.duplicate-check');section.hidden=false;
  section.querySelector('.duplicate-description').textContent=error.message;
  for(const input of [form.elements.duplicate_confirmed,form.elements.duplicate_reason]){input.disabled=false;required(input,true);}
}
export async function contractFile(form){
  const file=form.querySelector('input[type=file][name=file]')?.files?.[0];if(!file)return null;
  if(file.size>10*1024*1024)throw new Error('单个合同附件不能超过10MB，请压缩后重试。');
  if(form.dataset.form==='archive-contract'&&!/\.(pdf|png|jpe?g|webp)$/i.test(file.name))throw new Error('归档签章件须为PDF或图片；其他原件可先作为合同附件保存。');
  const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error('文件读取失败，请重新选择'));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file);});
  return {name:file.name,base64};
}
