import {canManageContract} from './contract-access.js';
import {profitEditor} from './profit-editor.js';
import {esc,input,select,textarea,formShell,actionButton as button} from '../ui.js';

const moneyInput=(key,label,value)=>`<label class="field">${esc(label)}<input readonly aria-readonly="true" data-summary="${key}" aria-label="${esc(label)}" type="number" step="any" value="${value==null?'':key==='product_margin_rate'?Math.round(value*10000)/100:value/100}"></label>`;
const summaryDate=(key,label,value)=>`<label class="field">${label}<input readonly aria-readonly="true" data-summary="${key}" aria-label="${label}" type="date" value="${esc(value||'')}"></label>`;
const stamp=value=>value?new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,16):'';
const kinds=['标品','实施','交付','定开','运维'];
export function maintenanceItem(i={},options={}){const locked=options.locked;return `<div class="maintenance-item" data-contract-item="${i.id||''}"><label class="field">售卖产品<input data-field="name" value="${esc(i.name||'')}" required ${locked?'readonly':''}></label><label class="field">产品类型<select data-field="kind" ${locked?'disabled':''}>${[...new Set([...kinds,...(i.kind?[i.kind]:[])])].map(k=>`<option ${k===i.kind?'selected':''}>${esc(k)}</option>`).join('')}</select></label><label class="field">明细金额（元）<input data-field="amount" type="number" min="0.01" step="0.01" value="${i.amount==null?'':i.amount/100}" required ${locked?'readonly':''}></label>${profitEditor(i)}<button type="button" class="btn ghost text-danger maintenance-remove" data-action="maintenance-remove-item">移除此明细</button></div>`;}
export function maintenancePayment(S,c,p={}){
 if(['已核销','已作废'].includes(p.status))return `<div class="workflow-notice">计划 #${p.id} · ${esc(p.status)} · 原约定 ${p.amount/100}元，历史在收款计划与流水中保留。</div>`;
 const control=(key,label,type='text',value=p[key]??'')=>`<label class="field">${label}<input data-pay-field="${key}" type="${type}" value="${esc(value)}" ${type==='number'?'min="0" step="0.01"':''}></label>`;
 return `<fieldset class="maintenance-payment" data-payment-row="${p.id||''}"><legend>${p.id?'回款 #'+p.id:'新增回款'}</legend><label class="field">关联合同<select data-pay-field="contract_id">${S.contracts.filter(x=>canManageContract(S,x)&&x.lifecycle!=='草稿').map(x=>`<option value="${x.id}" ${x.id===(p.contract_id||c.id)?'selected':''}>${esc(x.contract_no||x.code)} · ${esc(x.name)}</option>`).join('')}</select></label><label class="field">本笔状态<select data-pay-field="status">${(p.id?(p.status==='已到账'?['已到账']:['待到账','逾期']):['待到账','已到账','逾期']).map(s=>`<option ${s===(p.status||'待到账')?'selected':''}>${s}</option>`).join('')}</select></label>${control('amount','本笔回款金额（元）','number',p.amount==null?'':p.amount/100)}${control('product_amount','其中产品回款（元）','number',p.product_amount==null?'':p.product_amount/100)}${control('pay_date','实际回款时间','date')}${control('promise_date','预计回款时间','date')}${control('checkpoint_date','催办检查点','date')}${control('note','本笔备注')}</fieldset>`;
}
export function maintenanceForm(S,type,c,options){
 if(!canManageContract(S,c))return '';
 const r=type==='contract-project'?(S.collections??S.contracts).find(x=>x.id===c.id)||c:c;
 const sellers=S.users.filter(u=>(S.actor.role==='admin'||u.id===S.actor.id)&&u.active&&u.role!=='pm'&&u.business_member!==0&&!u.developer_admin);
 const metadata=select('customer_id','客户名称',S.customers.filter(x=>x.id===c.customer_id||S.actor.role==='admin'||x.owner_id===S.actor.id&&!x.shared).map(x=>[x.id,x.name]),c.customer_id)+input('name','合同名称',c.name)+input('contract_no','合同编号',c.contract_no||'','text',false)+select('owner_id','销售小二',[['','归属待核对'],...sellers.map(u=>[u.id,u.name])],c.owner_id||'',S.actor.role==='admin'?'':'disabled')+select('order_type','订单类型',[['','待补充'],'代销','经销','千帆'],c.order_type||'')+select('sale_type','销售类型',[['','待补充'],'新签自建','新签分发','续费','增购'],c.sale_type||'')+select('renewal_tag','产品续费标签',[['','待补充'],...options.renewalTags],c.renewal_tag||'')+select('payment_type','付款类型',[['','待补充'],...options.paymentTypes],c.payment_type||'')+input('sign_date','合同签订时间',c.sign_date||'','date',false)+input('valid_until','产品到期时间',c.valid_until||'','date',false)+input('created_at','创建时间',stamp(c.created_at),'datetime-local',false)+select('project_status','项目状态',[['','待补充'],...options.projectStatuses],r.project_status||'')+select('collaborator_pm','项目经理',[['','未指定'],...S.users.filter(u=>u.active&&u.role==='pm').map(u=>[u.id,u.name])],c.collaborator_pm||'')+input('delivery_staff','研发交付人员',r.delivery_staff||'','text',false);
 const finance=[['amount','合同金额',c.amount],['product_amount','产品金额',c.product_amount],['product_margin_rate','产品毛利率（%）',c.product_margin_rate],['product_margin','产品毛利',r.product_margin],['service_amount','项目／服务金额',c.service_amount],['service_margin','项目／服务毛利',r.service_margin],['total_margin','总毛利',r.total_margin],['collected','已回款金额',r.collected],['outstanding','未回款金额',r.outstanding]].map(([k,l,v])=>moneyInput(k,l,v)).join('');
 const dates=summaryDate('last_received_at','回款时间',r.last_received_at)+summaryDate('next_expected_at','预计回款时间',r.next_expected_at)+`<label class="field">回款状态<select disabled data-summary="collection_status">${['未回款','部分回款','已结清'].map(s=>`<option ${s===(c.collection_status||'未回款')?'selected':''}>${s}</option>`).join('')}</select></label>`;
 const items=`<section class="wide maintenance-items"><div class="section-head"><h3>售卖产品 / 产品类型</h3>${button('添加明细','maintenance-add-item','','ghost')}</div><div class="maintenance-item-list">${c.items.map(maintenanceItem).join('')}</div></section>`;
 const payments=`<section class="wide maintenance-payments"><div class="section-head"><h3>回款明细</h3>${button('添加回款','maintenance-add-payment',c.id,'ghost')}</div>${c.payments.map(p=>maintenancePayment(S,c,p)).join('')}</section>`;
 const attachment=`<section class="wide maintenance-attachments"><h3>合同附件</h3>${(c.attachments||[]).map(f=>button(f.filename,'record-attachment',f.id,'ghost')).join('')}${button('维护附件','maintenance-attachments',c.id,'secondary')}</section>`;
 const section=(title,body,opened=false)=>`<details class="wide maintenance-section" ${opened?'open':''}><summary>${title}</summary><div class="form-grid">${body}</div></details>`;
 return formShell('高级统一维护','用于跨资料与流水的统一调整；日常可使用基本资料、项目进度或到账短表单。',
  (c.locks?.message?`<div class="wide workflow-notice warning">${esc(c.locks.message)}</div>`:'')+
  section('基本资料',metadata,true)+section('自动汇总（只读）',finance+dates)+section('产品与服务明细',items)+section('收款计划与到账',payments)+section('范围、备注与附件',textarea('scope','交付范围',c.scope||'')+textarea('project_note','备注',r.project_note||'')+attachment)+textarea('reason','统一变更依据','',true),type,c.id,'保存并保留变更记录');
}

const controls=row=>Object.fromEntries([...row.querySelectorAll('[data-field],[data-pay-field]')].map(el=>[el.dataset.field||el.dataset.payField,el.value]));
const cents=value=>value===''?null:Math.round(Number(value)*100);
function items(form){return [...form.querySelectorAll('[data-contract-item]')];}
function payments(form){return [...form.querySelectorAll('[data-payment-row]')];}
const summary=(form,key)=>form.querySelector(`[data-summary="${key}"]`);
const set=(form,key,value)=>{const el=summary(form,key);if(el){el.value=value==null?'':key==='product_margin_rate'?Math.round(value*10000)/100:value/100;el.setCustomValidity('');}};
function recalcItems(form){
 const rows=items(form).map(controls),sum=(list,key)=>list.some(r=>r[key]==='')?null:list.reduce((s,r)=>s+(cents(r[key])||0),0),p=rows.filter(r=>r.kind==='标品'),s=rows.filter(r=>r.kind!=='标品');
 for(const row of rows)row.margin_before_expense=row.margin_before_expense===''?'':String(Number(row.margin_before_expense)-Number(row.business_expense||0));
 const amount=sum(rows,'amount'),product=sum(p,'amount'),service=sum(s,'amount'),pm=sum(p,'margin_before_expense'),sm=sum(s,'margin_before_expense');
 for(const [key,value] of Object.entries({amount,product_amount:product,service_amount:service,product_margin:pm,service_margin:sm,total_margin:pm==null||sm==null?null:pm+sm,product_margin_rate:pm==null||!product?null:pm/product}))set(form,key,value);
 const box=form.querySelector('[data-items-summary]');if(box)box.textContent=`合同合计 ¥${((amount||0)/100).toLocaleString('zh-CN')} · 产品 ¥${((product||0)/100).toLocaleString('zh-CN')} · 服务 ¥${((service||0)/100).toLocaleString('zh-CN')}`;
}
function recalcPayments(form){
 const rows=payments(form).map(controls),paid=rows.filter(p=>p.status==='已到账'),amount=paid.reduce((s,p)=>s+(cents(p.amount)||0),0),dates=paid.map(p=>p.pay_date).filter(Boolean).sort(),expected=rows.filter(p=>p.status!=='已到账').map(p=>p.promise_date).filter(Boolean).sort();
 set(form,'collected',amount);const total=cents(summary(form,'amount')?.value||'');set(form,'outstanding',total==null?null:total-amount);
 if(summary(form,'last_received_at')){summary(form,'last_received_at').value=dates.at(-1)||'';summary(form,'last_received_at').setCustomValidity('');}
 if(summary(form,'next_expected_at')){summary(form,'next_expected_at').value=expected[0]||'';summary(form,'next_expected_at').setCustomValidity('');}
 if(summary(form,'collection_status')){summary(form,'collection_status').value=amount===0?'未回款':total!=null&&amount>=total?'已结清':'部分回款';summary(form,'collection_status').setCustomValidity('');}
}
export function mountMaintenance(form,record){
 if(!form?.querySelector('.maintenance-items'))return;
 for(const el of form.querySelectorAll('[name],[data-summary],[data-field],[data-pay-field]'))el.dataset.initial=el.value;
 if(form.querySelector('[data-items-summary]'))recalcItems(form);
 form.addEventListener('profit-updated',()=>recalcItems(form));
 form.addEventListener('change',e=>{
  const el=e.target;
  if(el.dataset.field){if(['amount','margin_before_expense','business_expense','kind'].includes(el.dataset.field))recalcItems(form);return;}
  if(el.dataset.payField){recalcPayments(form);return;}
 });
}
export function maintenancePayload(form){
 const fields={};for(const el of form.querySelectorAll('[name]'))if(el.name!=='reason'&&el.value!==el.dataset.initial){if(el.name==='created_at'&&!el.value)throw new Error('创建时间不能为空');fields[el.name]=el.name==='created_at'?new Date(el.value+':00+08:00').toISOString():el.value;}
 const reason=form.elements.reason.value;
 const changed=row=>!row.dataset.contractItem&&!row.dataset.paymentRow||[...row.querySelectorAll('[data-field],[data-pay-field]')].some(el=>el.value!==el.dataset.initial);
 const changedItems=items(form).some(changed)||form.dataset.itemsRemoved==='true';
 const itemRows=changedItems?items(form).map(row=>{const v=controls(row);if(v.margin_before_expense==='')v.margin_before_expense=null;return {id:row.dataset.contractItem?Number(row.dataset.contractItem):null,...v};}):undefined;
 const paymentRows=payments(form).filter(changed).map(row=>({id:row.dataset.paymentRow?Number(row.dataset.paymentRow):null,...controls(row)}));
 return {data_correction:true,fields,...(itemRows?{items:itemRows}:{}),...(paymentRows.length?{payments:paymentRows}:{}),reason};
}
export function bindMaintenanceActions(getState){
 document.addEventListener('click',e=>{
  const target=e.target.closest('[data-action]');if(!target||!['maintenance-add-item','maintenance-add-payment','maintenance-remove-item'].includes(target.dataset.action))return;
  e.preventDefault();e.stopImmediatePropagation();const form=target.closest('form');if(!form)return;
  if(target.dataset.action==='maintenance-remove-item'){if(form.querySelectorAll('[data-contract-item]').length<=1)return;target.closest('[data-contract-item]').remove();form.dataset.itemsRemoved='true';return;}
  if(target.dataset.action==='maintenance-add-item')form.querySelector('.maintenance-item-list').insertAdjacentHTML('beforeend',maintenanceItem());
  else {const S=getState(),c=S.contracts.find(x=>x.id===Number(form.dataset.id));form.querySelector('.maintenance-payments').insertAdjacentHTML('beforeend',maintenancePayment(S,c));}
 });
}
