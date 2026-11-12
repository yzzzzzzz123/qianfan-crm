import {actionButton as button,badge,dateLabel,esc,formShell,icon,plainMoney,select,textarea} from '../ui.js';

const itemKinds=['标品','实施','定开','交付','运维'];

function suggestedItem(opportunity) {
  if(!opportunity)return {};
  const total=Object.hasOwn(opportunity,'forecast_amount')?opportunity.forecast_amount:opportunity.amount;
  const product=Object.hasOwn(opportunity,'forecast_product_amount')?opportunity.forecast_product_amount:opportunity.product_amount;
  return {
    name:opportunity.name,
    list_price:Number.isSafeInteger(total)?total/100:'',
    kind:total>0&&product===total?'标品':'',
  };
}

export function quoteItemRow(index,initial={}) {
  return `<div class="quote-item-row" data-item="${index}">
    <label class="field">产品或服务<input data-field="name" required value="${esc(initial.name||'')}"></label>
    <label class="field">类型<select data-field="kind" required><option value="">请选择</option>${itemKinds.map(k=>`<option ${k===initial.kind?'selected':''}>${k}</option>`).join('')}</select></label>
    <label class="field">数量<input type="number" data-field="quantity" required min="0.01" step="0.01" value="${esc(initial.quantity??1)}"></label>
    <label class="field">原价单价（元）<input type="number" data-field="list_price" required min="0" step="0.01" value="${esc(initial.list_price??'')}"></label>
    <label class="field">折扣（%）<input type="number" data-field="discount_percent" required min="0" max="100" step="0.01" value="${esc(initial.discount_percent??100)}"></label>
    <button type="button" class="icon-btn" data-action="remove-quote-item" aria-label="移除此报价明细">${icon('close')}</button>
  </div>`;
}

export function formQuotes(S,id,options) {
  const o=S.opportunities.find(row=>row.id===Number(id));
  return formShell('登记报价','',
    select('opportunity_id','关联商机',[['','请选择商机'],...options.oppOptions],id||'','required')+
    `<div class="wide items-editor"><div class="section-head"><h3>报价明细</h3><button type="button" class="btn ghost" data-action="add-quote-item">${icon('plus')}添加明细</button></div><div id="quote-items">${quoteItemRow(0,suggestedItem(o))}</div><p class="quote-total">折后合计 <b id="quote-total">0.00</b> 元</p></div>
    <label class="field wide">报价附件（选填）<input type="file" name="file" accept=".pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp"><small class="muted">支持 PDF、Word（.docx）、Excel（.xlsx）和图片，最多 10 MB。</small></label>`+
    textarea('note','备注'),'quote',id,'保存报价');
}

export function syncQuoteTotal(form) {
  if(!form)return;
  const total=[...form.querySelectorAll('.quote-item-row')].reduce((sum,row)=>{
    const quantity=Number(row.querySelector('[data-field="quantity"]').value||0);
    const price=Math.round(Number(row.querySelector('[data-field="list_price"]').value||0)*100);
    const discount=Number(row.querySelector('[data-field="discount_percent"]').value||0)/100;
    return sum+Math.round(Math.round(price*quantity)*discount);
  },0)/100;
  form.querySelector('#quote-total').textContent=total.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
}

export function mountQuoteForm(form,S) {
  if(!form)return;
  const items=form.querySelector('#quote-items');
  let edited=false;
  form.addEventListener('input',e=>{
    if(!items.contains(e.target))return;
    edited=true;
    syncQuoteTotal(form);
  });
  form.addEventListener('change',e=>{
    if(items.contains(e.target))edited=true;
    if(e.target.name!=='opportunity_id'||edited||items.children.length!==1)return;
    const o=S.opportunities.find(row=>row.id===Number(e.target.value));
    items.innerHTML=quoteItemRow(0,suggestedItem(o));
    syncQuoteTotal(form);
  });
  syncQuoteTotal(form);
}

const optionalMoney=value=>value==null?'未提供':plainMoney(value);

export function quoteRecord(q,index,S) {
  const current=q.is_current??index===0;
  const label=q.quote_status||(current?q.valid_until&&q.valid_until<S.today?'当前已过期':q.valid_until?'当前有效':'当前报价':'历史版本');
  const attachments=(q.attachments||[]).map(f=>button(f.filename,'record-attachment',f.id,'ghost','download')).join('');
  return `<article class="quote-record ${current?'is-current':''}">
    <div class="opportunity-quote-heading"><b>${esc(q.code)}</b>${badge(label,label==='当前已过期'?'warning':current?'blue':'neutral')}</div>
    <div class="quote-line"><div><b>${optionalMoney(q.amount)}</b>${q.valid_until?`<small>有效期至 ${esc(dateLabel(q.valid_until))}</small>`:''}</div>${button('导出Word','download-quote',q.id,'ghost','download')}</div>
    ${attachments?`<div class="opportunity-quote-attachments" role="group" aria-label="报价附件">${attachments}</div>`:''}
    ${q.note?`<p class="opportunity-quote-note">${esc(q.note)}</p>`:''}
    ${q.items?.length?`<details><summary>${q.items.length} 项报价明细</summary><div class="table-scroll"><table class="data-table detail-table"><thead><tr><th>内容</th><th>数量</th><th>原价单价</th><th>折扣</th><th>小计</th></tr></thead><tbody>${q.items.map(i=>`<tr><td>${esc(i.name)}</td><td>${esc(i.quantity)}</td><td>${optionalMoney(i.list_price)}</td><td>${Math.round(i.discount_rate*10000)/100}%</td><td>${optionalMoney(i.amount)}</td></tr>`).join('')}</tbody></table></div></details>`:''}
  </article>`;
}
