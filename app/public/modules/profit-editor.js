import {esc,plainMoney} from '../ui.js';
const deliveryKinds=new Set(['实施','交付']);
const percent=value=>`${Number(value).toLocaleString('zh-CN',{maximumFractionDigits:2})}%`;
const toCents=value=>Math.round(Number(value)*100);

export function profitEditor(i={},unit='cents',attributes='data-field'){
 const amount=i.amount==null||i.amount===''?null:unit==='cents'?Number(i.amount)/100:Number(i.amount);
 let base=(i.margin_before_expense??i.margin)==null?null:unit==='cents'?Number(i.margin_before_expense??i.margin)/100:Number(i.margin_before_expense??i.margin);
 const expense=unit==='cents'?(i.business_expense||0)/100:Number(i.business_expense||0),delivery=deliveryKinds.has(i.kind);
 const automatic=delivery&&(base==null&&!i.id||base!=null&&amount!=null&&toCents(base)===toCents(amount));
 if(automatic&&base==null&&amount!=null)base=amount;
 const rate=automatic?100:base!=null&&amount?Math.round(base/amount*10000)/100:'';
 return `<div class="profit-editor" data-profit-editor data-profit-existing="${i.id?'true':'false'}" data-profit-basis="${automatic?'auto':'manual'}" data-profit-input-mode="rate" data-profit-expanded="${delivery?'false':'true'}">
  <div class="profit-basis">
   <div class="profit-basis-summary" data-profit-basis-summary ${delivery?'':'hidden'}><span>费用前毛利 <strong data-profit-base-summary>${base==null?'待填写':plainMoney(toCents(base))}${rate!==''?' · '+percent(rate):''}</strong></span><button type="button" class="text-link" data-profit-adjust>${base==null?'填写毛利':'调整毛利'}</button></div>
   <div class="profit-entry" data-profit-entry ${delivery||!i.kind?'hidden':''}>
    <div class="profit-mode-switch" role="group" aria-label="毛利录入方式"><button type="button" data-profit-mode-choice="rate" aria-pressed="true">按毛利率</button><button type="button" data-profit-mode-choice="amount" aria-pressed="false">按毛利金额</button><button type="button" class="text-link profit-default" data-profit-default ${delivery?'':'hidden'}>恢复100%</button></div>
    <label class="field profit-rate-field" data-profit-rate-field>费用前毛利率（%）<input type="number" data-profit-rate min="0" max="100" step="0.01" value="${esc(rate)}" ${delivery||!i.kind?'disabled':''}></label>
    <label class="field profit-base-field" data-profit-base-field hidden>费用前毛利（元）<input type="hidden" ${attributes}="margin_before_expense" min="0" step="0.01" value="${base??''}"></label>
   </div>
  </div>
  <label class="field profit-expense">合同费用支出（元）<input type="number" ${attributes}="business_expense" min="0" step="0.01" value="${expense}" ${i.expense_detail_count?'readonly aria-readonly="true"':''}>${i.expense_detail_count?'<small>已按逐笔费用汇总，请在费用明细中修改。</small>':''}</label>
  <div class="profit-result" data-profit-result data-profit-state="pending" role="status" aria-live="polite"><span class="profit-result-label">预计毛利</span><output data-profit-net>待填写</output><span class="profit-result-rate" data-profit-net-rate></span></div>
 </div>`;
}
export function profitSummary(S,c){if(S.actor.role==='pm')return '';const rate=c.total_margin_rate??(c.total_margin!=null&&c.amount?c.total_margin/c.amount:null);return `<section class="detail-section profit-detail"><h3>合同毛利与合同费用支出</h3><div class="profit-summary">${[['费用前毛利',c.margin_before_expense],['合同费用支出',c.business_expense],['扣费后毛利',c.total_margin]].map(([label,v])=>`<div><span>${label}</span><strong>${v==null?'待核对':plainMoney(v)}</strong></div>`).join('')}<div><span>扣费后毛利率</span><strong>${rate==null?'待核对':Math.round(rate*10000)/100+'%'}</strong></div></div><p class="muted">扣费后毛利＝费用前毛利－合同费用支出；合同汇总来自有效产品及服务明细。</p></section>`;}
export function installProfitEditors(){
 const rowSelector='.item-row,.maintenance-item,form[data-form="item-margin"]';
 const field=(row,key)=>row.querySelector(`[data-field="${key}"],[name="${key}"]`);
 const setText=(el,text)=>{if(el&&el.textContent!==text)el.textContent=text;};
 function sync(row,source){
  const box=row.querySelector('[data-profit-editor]');if(!box)return;
  const amountEl=field(row,'amount'),rawAmount=amountEl?.value??row.dataset.profitAmount,amount=rawAmount==null||rawAmount===''?null:Number(rawAmount),amountCents=Number.isFinite(amount)&&amount>0?toCents(amount):null;
  const kindEl=field(row,'kind'),kind=kindEl?.value||row.dataset.profitKind||'',delivery=deliveryKinds.has(kind),base=field(row,'margin_before_expense'),expense=field(row,'business_expense'),rate=box.querySelector('[data-profit-rate]');
  if(!base)return;
  const setFromRate=()=>{base.value=rate.value===''||amountCents==null?'':String(Math.round(amountCents*Number(rate.value)/100)/100);};
  const setRate=()=>{rate.value=base.value===''||amountCents==null?'':String(Math.round(toCents(base.value)/amountCents*10000)/100);};
  if(!box.dataset.initialized){
   // Only new delivery rows receive an inferred margin. Historical unknowns
   // and custom margins stay exactly as recorded until explicitly adjusted.
   if(delivery&&base.value===''&&box.dataset.profitExisting!=='true')box.dataset.profitBasis='auto';
   if(box.dataset.profitBasis==='auto'){rate.value='100';base.value=amountCents==null?'':String(amountCents/100);}
   else setRate();
  }else if(source===kindEl&&kind!==box.dataset.profitKind){
   if(delivery){box.dataset.profitBasis='auto';box.dataset.profitExpanded='false';rate.value='100';base.value=amountCents==null?'':String(amountCents/100);}
   else {if(box.dataset.profitBasis==='auto'){base.value='';rate.value='';}box.dataset.profitBasis='manual';box.dataset.profitExpanded='true';}
  }else if(box.dataset.profitBasis==='auto'&&delivery){rate.value='100';base.value=amountCents==null?'':String(amountCents/100);}
  else if(source===rate){setFromRate();}
  else if(source===base){setRate();}
  else if(source===amountEl){if(box.dataset.profitInputMode==='rate')setFromRate();else setRate();}
  box.dataset.initialized='true';box.dataset.profitKind=kind;
  const entry=box.querySelector('[data-profit-entry]'),showEntry=!!kind&&(!delivery||box.dataset.profitExpanded==='true'),mode=box.dataset.profitInputMode||'rate';
  box.querySelector('[data-profit-basis-summary]').hidden=!delivery;entry.hidden=!showEntry;
  box.querySelector('[data-profit-rate-field]').hidden=mode!=='rate';box.querySelector('[data-profit-base-field]').hidden=mode!=='amount';
  rate.disabled=!showEntry||mode!=='rate';base.type=showEntry&&mode==='amount'?'number':'hidden';
  if(amountCents!=null)base.max=String(amountCents/100);else base.removeAttribute('max');
  for(const choice of box.querySelectorAll('[data-profit-mode-choice]'))choice.setAttribute('aria-pressed',String(choice.dataset.profitModeChoice===mode));
  box.querySelector('[data-profit-default]').hidden=!delivery;
  const baseCents=base.value===''?null:toCents(base.value),expenseCents=expense?.value===''?0:toCents(expense?.value||0),value=baseCents==null||amountCents==null?null:baseCents-expenseCents;
  setText(box.querySelector('[data-profit-base-summary]'),baseCents==null?'待填写':`${plainMoney(baseCents)}${amountCents==null?'':' · '+percent(baseCents/amountCents*100)}`);
  setText(box.querySelector('[data-profit-adjust]'),baseCents==null?'填写毛利':'调整毛利');
  setText(box.querySelector('[data-profit-net]'),value==null?'待填写':plainMoney(value));
  setText(box.querySelector('[data-profit-net-rate]'),value==null?'':`毛利率 ${percent(value/amountCents*100)}`);
  setText(row.querySelector('[data-profit-compact]'),value==null?'毛利待填写':`毛利 ${plainMoney(value)}`);
  box.querySelector('[data-profit-result]').dataset.profitState=value==null?'pending':value<0?'loss':'known';
  if(expense)expense.setCustomValidity('');
 }
 function total(form){
  const output=form?.querySelector('[data-profit-contract-preview]');if(!output)return;
  const rows=[...form.querySelectorAll('.item-row,.maintenance-item')],amount=rows.reduce((s,r)=>s+(toCents(field(r,'amount')?.value||0)||0),0),expense=rows.reduce((s,r)=>s+(toCents(field(r,'business_expense')?.value||0)||0),0),unknown=rows.some(r=>field(r,'margin_before_expense')?.value===''),base=rows.reduce((s,r)=>s+(toCents(field(r,'margin_before_expense')?.value||0)||0),0);
  setText(output,`合同金额 ${plainMoney(amount)} · 合同费用支出 ${plainMoney(expense)} · 预计毛利 ${unknown?'待填写':plainMoney(base-expense)}${unknown||!amount?'':' · 毛利率 '+percent((base-expense)/amount*100)}`);
 }
 function update(row,source){sync(row,source);total(row.closest('form'));row.dispatchEvent(new Event('profit-updated',{bubbles:true}));}
 for(const name of ['input','change'])document.addEventListener(name,event=>{const row=event.target.closest(rowSelector);if(row)update(row,event.target);});
 document.addEventListener('click',event=>{
  const control=event.target.closest('[data-profit-mode-choice],[data-profit-adjust],[data-profit-default]');if(!control)return;
  const row=control.closest(rowSelector),box=control.closest('[data-profit-editor]');if(!row||!box)return;event.preventDefault();
  if(control.matches('[data-profit-mode-choice]'))box.dataset.profitInputMode=control.dataset.profitModeChoice;
  if(control.matches('[data-profit-adjust]')){box.dataset.profitExpanded='true';box.dataset.profitBasis='manual';}
  if(control.matches('[data-profit-default]')){box.dataset.profitExpanded='false';box.dataset.profitBasis='auto';}
  update(row);
  if(!control.matches('[data-profit-default]'))box.querySelector(box.dataset.profitInputMode==='amount'?'[data-profit-base-field] input':'[data-profit-rate]')?.focus();
 });
 function initialize(records=[]){
  const forms=new Set();for(const row of document.querySelectorAll(rowSelector))if(row.querySelector('[data-profit-editor]')&&!row.querySelector('[data-profit-editor]').dataset.initialized){sync(row);if(row.closest('form'))forms.add(row.closest('form'));}
  for(const record of records){const form=record.target.closest?.('form');if(form)forms.add(form);}
  for(const form of forms)total(form);
 }
 const observer=new MutationObserver(records=>{if(records.some(r=>[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1&&(n.matches('[data-profit-editor],'+rowSelector)||n.querySelector('[data-profit-editor]')))))initialize(records);});
 observer.observe(document.documentElement,{subtree:true,childList:true});initialize();
}
