import {esc,plainMoney,dateLabel,badge,actionButton as button,input,select,textarea,formShell,empty} from '../ui.js';
import {bindCommittedSearch} from './search-input.js';

const style='<link rel="stylesheet" href="./modules/data-review.css">';
const money=value=>value==null?'待核对':plainMoney(value);
const yuan=value=>value==null?'':Number(value)/100;
const hidden=(name,value)=>`<input type="hidden" name="${name}" value="${esc(JSON.stringify(value))}">`;
const notice=text=>`<div class="review-notice">${text}</div>`;
const heading=(title,description,actions='')=>`<header class="dialog-head"><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div><button type="button" class="icon-btn" data-action="close" aria-label="关闭">×</button></header>${actions?`<div class="review-toolbar">${actions}</div>`:''}`;
const fieldLabels={customer_id:'客户',opportunity_id:'关联商机',owner_id:'销售归属',name:'合同名称',contract_no:'合同编号',sale_type:'销售分类',order_type:'订单类型',renewal_tag:'产品续费标签',payment_type:'付款类型',sign_date:'签约日期',valid_until:'产品到期日',created_at:'创建时间',project_status:'项目状态',collaborator_pm:'项目经理',delivery_staff:'研发交付人员',project_note:'项目备注',scope:'交付范围'};
const numberFields=new Set(['customer_id','opportunity_id','owner_id','collaborator_pm']);
const nullableFields=new Set(['contract_no','opportunity_id','valid_until','renewal_tag','payment_type','project_status','collaborator_pm','delivery_staff','project_note']);
const withCurrent=(options,value)=>value!=null&&value!==''&&!options.some(o=>String(Array.isArray(o)?o[0]:o)===String(value))?[...options,[value,`${value}（现有值）`]]:options;
const options=(rows,label)=>rows.map(row=>[row.id,label(row)]);
const fieldSelect=(key,label,values,value,extra='')=>select(key,label,withCurrent(values,value),value??'',extra);
const sourceText=value=>typeof value==='object'?JSON.stringify(value,null,2):String(value??'');
const itemValue=i=>({...(i.id?{id:Number(i.id)}:{}),name:i.name||'',kind:i.kind||'',amount:yuan(i.amount),margin_before_expense:yuan(Object.hasOwn(i,'margin_before_expense')?i.margin_before_expense:i.margin)});
const paymentValue=p=>({id:Number(p.id),contract_id:Number(p.contract_id),amount:yuan(p.amount),status:p.raw_status||p.status,pay_date:p.pay_date||'',promise_date:p.promise_date||'',checkpoint_date:p.checkpoint_date||'',product_amount:yuan(p.product_amount),reference_no:p.reference_no||'',note:p.note||''});

export function reviewList(S,data,queued=[]){
  const records=data.records||[],ids=new Set((queued instanceof Map?[...queued.values()]:queued).map(c=>Number(c.contract_id))),issues=records.filter(c=>c.issues?.length);
  const rows=records.map(c=>`<tr data-review-record data-review-search="${esc([c.contract_no,c.name,c.customer_name,c.owner_name,...(c.issues||[])].join(' ').toLowerCase())}" data-review-issues="${c.issues?.length?'yes':'no'}"><td><strong>${esc(c.contract_no||'HT-'+c.id)}</strong><span class="record-meta">${esc(c.name)}</span></td><td>${esc(c.customer_name||'待补充')}<span class="record-meta">销售：${esc(c.owner_name||'未分配')}</span></td><td class="number">${money(c.amount)}<span class="record-meta">未收 ${money(c.outstanding)}</span></td><td>${(c.issues||[]).map(issue=>badge(issue,'warning')).join(' ')||badge('暂无自动提示','success')}</td><td>${ids.has(c.id)?badge('已加入清单','blue'):''}${button('核对并修正','review-contract',c.id,'ghost')}</td></tr>`).join('');
  return style+heading('迁移资料核对','对照来源原文核对合同与回款，先加入修正清单，再统一预览和保存。',button(`查看修正清单（${ids.size}）`,'review-queue','','primary')+button('结算差额核对','settlement-review','','ghost'))+`<div class="drawer-body review-workspace"><div class="review-stats"><span>合同 <strong>${records.length}</strong></span><span>有待核对提示 <strong>${issues.length}</strong></span><span>暂存修正 <strong>${ids.size}</strong></span></div>${notice('自动提示是核对线索。来源原文仅供对照，加入清单不会写入业务数据。合同费用支出请到费用明细维护。')}<div class="review-filters"><label class="field">搜索合同、客户、销售或提示<input type="search" data-review-search-input placeholder="输入关键词筛选" autocomplete="off"></label><label class="review-check"><input type="checkbox" data-review-issues-only>只看有待核对提示</label><span class="muted" data-review-filter-count>${records.length}份合同</span></div><div class="table-scroll"><table class="data-table review-table"><thead><tr><th>合同</th><th>客户／销售归属</th><th>金额</th><th>待核对提示</th><th>修正</th></tr></thead><tbody>${rows||'<tr><td colspan="5">暂无有效合同</td></tr>'}</tbody></table></div><p class="muted" data-review-no-match hidden>没有匹配的合同，请调整关键词或筛选条件。</p></div>`;
}

function itemRow(item={},index=0){
  const i=itemValue(item),expense=item.business_expense||0;
  return `<article class="review-record" data-review-item data-review-id="${i.id||''}" data-review-expense="${expense}"><div class="review-record-head"><strong>合同明细 <span data-review-item-number>${index+1}</span>${i.id?` · #${i.id}`:''}</strong><button type="button" class="btn ghost text-danger" data-review-remove-item ${expense?'disabled title="请先到费用明细处理本行已有费用"':''}>移除此明细</button></div><div class="review-fields">${input('item_name','内容',i.name,'text',true,'data-review-key="name" maxlength="160"')}${fieldSelect('item_kind','类型',[['','请选择类型'],'标品','实施','交付','定开','运维'],i.kind,'data-review-key="kind" required')}${input('item_amount','金额（元）',i.amount,'number',true,'data-review-key="amount" min="0.01" step="0.01"')}${input('item_margin','费用前毛利（元）',i.margin_before_expense,'number',false,'data-review-key="margin_before_expense" min="0" step="0.01"')}<p class="review-wide field-help">实施／交付新增明细的费用前毛利默认等于金额；其他类型留空表示待核实。已有明细按录入的毛利核对。</p><div class="review-readonly"><span>合同费用支出（只读）</span><strong>${money(expense)}</strong></div><div class="review-readonly"><span>扣费后毛利</span><strong data-review-margin-preview>${i.margin_before_expense===''?'待核对':money(Math.round(Number(i.margin_before_expense)*100)-expense)}</strong></div></div></article>`;
}

function paymentRow(p){
  const value=paymentValue(p),received=p.record_type==='receipt'||p.status==='已到账';
  if(p.voided_at)return `<article class="review-record review-muted"><strong>收款计划 #${p.id} · 已作废</strong><p>${money(p.amount)} · ${dateLabel(p.promise_date)} · ${esc(p.note||'无备注')}</p><p class="field-help">已作废计划在回款管理中处理恢复，本页不修改。</p></article>`;
  return `<article class="review-record" data-review-payment data-review-id="${p.id}"><div class="review-record-head"><strong>${received?'实际到账':'收款计划'} #${p.id}</strong>${badge(p.status,received?'success':'neutral')}</div>${!received?`<p class="field-help">已核销 ${money(p.settled_amount||0)} · 计划余款 ${money(p.remaining_amount||0)}。修改计划不会新增到账或改变核销关系。</p>`:''}<div class="review-fields">${input('payment_amount','金额（元）',value.amount,'number',true,`data-review-key="amount" min="${!received&&p.settled_amount?yuan(p.settled_amount):'0.01'}" step="0.01"`)}${received?input('payment_pay_date','实际到账日期',value.pay_date,'date',false,'data-review-key="pay_date"'):input('payment_promise_date','预计收款日',value.promise_date,'date',false,'data-review-key="promise_date"')}${received?input('payment_product_amount','其中产品回款（元，选填）',value.product_amount,'number',false,'data-review-key="product_amount" min="0" step="0.01"'):input('payment_checkpoint_date','检查点（选填）',value.checkpoint_date,'date',false,'data-review-key="checkpoint_date"')}${received?input('payment_reference_no','银行流水号／凭证号（选填）',value.reference_no,'text',false,'data-review-key="reference_no" maxlength="160"'):''}<label class="field review-wide">${received?'回款说明':'计划备注'}<textarea rows="2" data-review-key="note" maxlength="1000">${esc(value.note)}</textarea></label>${received?`<p class="review-wide field-help">流水号和银行水单均选填。产品分配留空表示待核对，明确纯服务款填0。</p><details class="review-wide review-duplicate"><summary>重复凭证的特殊确认（仅确为独立款时使用）</summary><label class="review-check"><input type="checkbox" data-review-key="duplicate_confirmed" ${p.duplicate_confirmed?'checked':''}>已核对，确认是独立款或同笔汇款的合法分拆</label><label class="field">重复确认依据<input data-review-key="duplicate_reason" value="${esc(p.duplicate_reason||'')}" maxlength="1000" placeholder="确认后必须填写依据"></label></details>`:''}</div></article>`;
}

export function reviewEditor(S,c){
  if(!c)return empty('合同不存在');
  const users=S.users||[],customers=S.customers||[],opportunities=S.opportunities||[];
  const baseline={fields:Object.fromEntries(Object.keys(fieldLabels).map(key=>[key,c[key]??''])),items:(c.items||[]).map(itemValue),payments:(c.payments||[]).filter(p=>!p.voided_at).map(paymentValue)};
  if(c.review_change){
    const staged=c.review_change,oldItems=c.items||[],oldPayments=c.payments||[];
    c={...c,...staged.fields,
      items:staged.items?staged.items.map(i=>({...oldItems.find(old=>old.id===i.id),...i,amount:Math.round(Number(i.amount)*100),margin_before_expense:i.margin_before_expense==null?null:Math.round(Number(i.margin_before_expense)*100)})):oldItems,
      payments:oldPayments.map(p=>{const changed=staged.payments?.find(row=>row.id===p.id);return changed?{...p,...changed,amount:Math.round(Number(changed.amount)*100),product_amount:changed.product_amount==null?null:Math.round(Number(changed.product_amount)*100)}:p;})};
  }
  const currentFields=input('name','合同名称',c.name,'text',true,'maxlength="160"')+input('contract_no','合同编号',c.contract_no||'','text',false,'maxlength="80"')+
    fieldSelect('customer_id','客户',options(customers,row=>row.name),c.customer_id,'required')+fieldSelect('owner_id','销售归属',[['','请选择销售'],...options(users.filter(u=>u.role!=='pm'),u=>u.name)],c.owner_id,'required')+
    fieldSelect('opportunity_id','关联商机',[['','不关联商机'],...options(opportunities,o=>`${o.name} · ${o.code||'#'+o.id}`)],c.opportunity_id)+fieldSelect('order_type','订单类型',[['','待补充'],'代销','经销','千帆'],c.order_type)+
    fieldSelect('sale_type','销售分类',[['','待补充'],'新签自建','新签分发','续费','增购'],c.sale_type)+fieldSelect('renewal_tag','产品续费标签',[['','待补充'],'新签（自建）','新签（分发）','续费','经销品'],c.renewal_tag)+
    fieldSelect('payment_type','付款类型',[['','待补充'],'客户直付天元','千帆收款'],c.payment_type)+input('sign_date','签约日期',c.sign_date||'','date')+input('valid_until','产品到期日',c.valid_until||'','date',false)+
    input('created_at','创建时间（北京时间）',c.created_at?new Date(c.created_at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).slice(0,19).replace(' ','T'):'','datetime-local',false,'step="1"')+
    fieldSelect('project_status','项目状态',[['','待补充'],'交付中','验收中','已验收未结算','已结项','运维中','暂停','续费中'],c.project_status)+fieldSelect('collaborator_pm','项目经理',[['','未分配'],...options(users.filter(u=>u.role==='pm'&&u.active&&u.business_member&&!u.developer_admin),u=>u.name)],c.collaborator_pm)+input('delivery_staff','研发交付人员',c.delivery_staff||'','text',false,'maxlength="500"')+textarea('scope','交付范围',c.scope||'')+textarea('project_note','项目备注',c.project_note||'');
  const sources=(c.sources||[]).map((s,index)=>`<details class="review-source" ${index===0?'open':''}><summary>${esc(s.source_file||s.source||'来源记录 #'+s.id)}${s.sheet_name?` · ${esc(s.sheet_name)}`:''}${s.row_number!=null?` · 第${esc(s.row_number)}行`:''}</summary><p class="record-meta">${esc([s.source_table,s.reason].filter(Boolean).join(' · '))}</p><pre tabindex="0">${esc(sourceText(s.values))}</pre></details>`).join('')||'<p class="muted">暂无可对照的导入原文，请依据原合同或经核实的资料修正。</p>';
  const fields=style+hidden('review_baseline',baseline)+`<div class="wide review-workspace">${notice(`${esc(c.contract_no||'HT-'+c.id)} · ${esc(c.customer_name||'客户待补充')}。编辑后先加入清单，统一预览后才写入。`)}<div class="review-issue-list">${(c.issues||[]).map(i=>badge(i,'warning')).join(' ')}</div><div class="review-editor-grid"><aside class="review-source-column"><h3>来源原文</h3><p class="field-help">保留原文供核对，不会自动覆盖当前业务字段。</p>${sources}</aside><section class="review-current-column"><h3>当前合同字段</h3><div class="review-fields" data-review-contract-fields>${currentFields}</div></section></div><section class="review-section"><div class="review-section-head"><div><h3>合同明细与毛利</h3><p class="field-help">金额以元填写。费用按费用明细汇总，本页只读；调整金额后请同步核对毛利。</p></div>${button('维护费用明细','contract-expenses',c.id,'ghost')}</div><div data-review-items>${(c.items||[]).map(itemRow).join('')}</div><button type="button" class="btn ghost" data-review-add-item>添加合同明细</button><output class="review-totals" data-review-item-total>合同合计 ${money(c.amount)} · 费用 ${money(c.business_expense)} · 扣费后毛利 ${money(c.total_margin)}</output></section><section class="review-section"><h3>实际到账与收款计划</h3><p class="field-help">仅修正已存在记录；不会自动生成到账、删除计划或重新核销。新增、作废和恢复请到回款管理处理。</p>${(c.payments||[]).map(paymentRow).join('')||'<p class="muted">暂无回款或收款计划</p>'}</section></div>`;
  return formShell('核对合同与回款资料',c.name,fields,'review-stage',c.id,'加入修正清单');
}

const rowValue=(row,key)=>row.querySelector(`[data-review-key="${key}"]`)?.value??'';
const canonicalField=(key,value)=>numberFields.has(key)?value===''?null:Number(value):key==='created_at'?value?new Date(value.includes('+')||value.endsWith('Z')?value:value+'+08:00').toISOString():'':nullableFields.has(key)&&value===''?null:String(value??'');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function collectReviewChange(form){
  const baseline=JSON.parse(form.elements.namedItem('review_baseline').value),change={contract_id:Number(form.dataset.id),fields:{}};
  for(const [key,old] of Object.entries(baseline.fields)){
    const control=form.elements.namedItem(key);if(!control)continue;
    const value=canonicalField(key,control.value),before=canonicalField(key,old);
    if(value!==before)change.fields[key]=value;
  }
  const items=[...form.querySelectorAll('[data-review-item]')].map(row=>{
    const id=Number(row.dataset.reviewId),kind=rowValue(row,'kind'),amount=Number(rowValue(row,'amount')),base=rowValue(row,'margin_before_expense');
    if(!rowValue(row,'name').trim()||!kind||!Number.isFinite(amount)||amount<=0)throw new Error('请补全合同明细的名称、类型与正数金额');
    if(base!==''&&(!Number.isFinite(Number(base))||Number(base)<0||Number(base)>amount))throw new Error('费用前毛利须在0与明细金额之间');
    return {...(id?{id}:{}),name:rowValue(row,'name').trim(),kind,amount,margin_before_expense:base===''?!id&&['实施','交付'].includes(kind)?amount:null:Number(base)};
  });
  const oldItems=baseline.items.map(i=>({...i,amount:Number(i.amount),margin_before_expense:i.margin_before_expense===''?null:Number(i.margin_before_expense)}));
  if(!same(items,oldItems)){if(!items.length)throw new Error('合同至少保留一条明细');change.items=items;}
  const payments=[];
  for(const row of form.querySelectorAll('[data-review-payment]')){
    const old=baseline.payments.find(p=>p.id===Number(row.dataset.reviewId));if(!old)throw new Error('回款记录已变化，请重新打开核对');
    const normalized={...old,amount:Number(old.amount),product_amount:old.product_amount===''?null:Number(old.product_amount)};
    const current={...normalized};
    for(const control of row.querySelectorAll('[data-review-key]')){
      const key=control.dataset.reviewKey;if(key==='duplicate_confirmed'||key==='duplicate_reason')continue;
      current[key]=['amount','product_amount'].includes(key)?control.value===''?null:Number(control.value):control.value.trim();
    }
    if(!same(current,normalized)){
      if(!Number.isFinite(current.amount)||current.amount<=0)throw new Error('回款或计划金额须为大于0的数字');
      if(current.product_amount!=null&&(!Number.isFinite(current.product_amount)||current.product_amount<0||current.product_amount>current.amount))throw new Error('产品回款须在0与本笔回款金额之间');
      if(row.querySelector('[data-review-key="duplicate_confirmed"]')?.checked){
        const reason=rowValue(row,'duplicate_reason').trim();if(!reason)throw new Error('请填写本笔重复款确认依据');
        current.duplicate_confirmed=true;current.duplicate_reason=reason;
      }
      payments.push(current);
    }
  }
  if(payments.length)change.payments=payments;
  if(!Object.keys(change.fields).length&&!change.items&&!change.payments)throw new Error('本合同尚未修改内容，请核对后再加入清单');
  return change;
}

export function reviewQueue(changes,reason=''){
  if(!changes.length)return style+heading('修正清单','清单中的改动暂存在当前页面，刷新页面前请完成预览和提交。',button('返回资料核对','data-review','','ghost'))+empty('修正清单为空','先选择合同核对，再加入修正清单。');
  const records=changes.map(c=>`<article class="review-record"><div class="review-record-head"><strong>合同 #${c.contract_id}</strong><div>${button('继续核对','review-contract',c.contract_id,'ghost')}${button('移出清单','review-remove',c.contract_id,'ghost text-danger')}</div></div><p>${Object.keys(c.fields||{}).map(k=>esc(fieldLabels[k]||k)).join('、')||'合同基础字段未修改'}${c.items?` · 明细更新为${c.items.length}项`:''}${c.payments?` · 修正${c.payments.length}笔回款／计划`:''}</p></article>`).join('');
  return formShell('修正清单',`${changes.length}份合同 · 预览不会保存业务数据`,style+hidden('changes',changes)+`<div class="wide review-workspace">${notice('请填写能追溯到原合同或迁移资料的统一修正依据。预览会同时校验合同金额、回款分配、计划和已有费用。')}${records}</div>`+textarea('reason','统一修正依据',reason,true),'review-preview','','预览影响');
}

const summaryFields=[['amount','合同金额'],['collected','实际到账'],['outstanding','未收余额'],['planned_remaining','计划余款'],['business_expense','合同费用支出'],['total_margin','扣费后毛利'],['owner_name','销售归属'],['customer_name','客户']];
const detailLabels={...fieldLabels,kind:'明细类型',amount:'金额',margin_before_expense:'费用前毛利',business_expense:'合同费用支出',margin:'扣费后毛利',contract_id:'所属合同',pay_date:'实际到账日期',promise_date:'预计收款日',checkpoint_date:'检查点',product_amount:'其中产品回款',status:'状态',note:'备注',reference_no:'银行流水号／凭证号',retired_at:'删除时间',voided_at:'作废时间'};
const detailMoney=new Set(['amount','margin_before_expense','business_expense','margin','product_amount']);
function changeValue(field,value){
  if(value==null||value==='')return '<span class="muted">未填写</span>';
  if(detailMoney.has(field))return money(value);
  if(['owner_id','collaborator_pm'].includes(field))return `用户 #${esc(value)}`;
  if(['customer_id','opportunity_id','contract_id'].includes(field))return `${{customer_id:'客户',opportunity_id:'商机',contract_id:'合同'}[field]} #${esc(value)}`;
  if(['created_at','retired_at','voided_at'].includes(field)&&Number.isFinite(Date.parse(value)))return esc(new Date(value).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}))+'（北京时间）';
  return esc(sourceText(value));
}
function changesTable(changes){
  return `<div class="table-scroll"><table class="data-table review-table review-change-table"><thead><tr><th>修改字段</th><th>原值</th><th>修正值</th></tr></thead><tbody>${changes.map(c=>`<tr><th>${esc(detailLabels[c.field]||c.field)}</th><td>${changeValue(c.field,c.before)}</td><td>${changeValue(c.field,c.after)}</td></tr>`).join('')}</tbody></table></div>`;
}
function recordChanges(changes,type){
  if(!changes?.length)return '';
  return `<details class="review-preview-details"><summary>${type}变化（${changes.length}条）</summary>${changes.map(row=>{
    const fields=Object.keys(detailLabels).filter(field=>JSON.stringify(row.before?.[field]??null)!==JSON.stringify(row.after?.[field]??null)).map(field=>({field,before:row.before?.[field],after:row.after?.[field]}));
    const state=!row.before?'新增':!row.after?'移除':'修改';
    return `<div class="review-change-record"><h4>${type} #${esc(row.id||row.after?.id||row.before?.id||'新增')} · ${state}</h4>${fields.length?changesTable(fields):'<p class="field-help">资料记录已更新，无其他主要字段变化。</p>'}</div>`;
  }).join('')}</details>`;
}
export function reviewPreview(result,changes,reason){
  const records=(result.results||[]).map(c=>`<section class="review-record"><h3>${esc(c.contract_no||'HT-'+c.contract_id)} · ${esc(c.name)}</h3>${c.field_changes?.length?`<h4>合同字段变化</h4>${changesTable(c.field_changes)}`:''}${recordChanges(c.item_changes,'合同明细')}${recordChanges(c.payment_changes,'回款／计划')}<h4 class="review-summary-title">财务与归属汇总</h4><div class="table-scroll"><table class="data-table review-table"><thead><tr><th>核对项目</th><th>修正前</th><th>修正后</th></tr></thead><tbody>${summaryFields.map(([key,label])=>{const changed=c.before[key]!==c.after[key],fmt=v=>key.endsWith('_name')?esc(v||'未分配'):money(v);return `<tr class="${changed?'review-changed':''}"><th>${label}</th><td>${fmt(c.before[key])}</td><td>${fmt(c.after[key])}${changed?badge('变化','blue'):''}</td></tr>`;}).join('')}</tbody></table></div><p class="field-help">修正后提示：${c.issues_after?.length?c.issues_after.map(esc).join('；'):'暂无自动核对提示'}</p></section>`).join('');
  return formShell('确认修正影响','当前仅为预览；确认提交后整份清单统一保存。',style+hidden('payload',{changes,reason,fingerprint:result.fingerprint})+`<div class="wide review-workspace">${notice('已确认提成及绩效快照会保留。资料修正引起的差异可到“结算差额核对”查看参考，不会自动补发或追回。')}<p><strong>统一修正依据：</strong>${esc(reason)}</p>${records}</div><label class="wide review-check"><input type="checkbox" name="confirmed" required>已核对修正前后数据和依据，确认保存本清单</label>`,'review-apply','','确认提交修正');
}

export function mountReviewList(root){
  if(!root||root.dataset.reviewMounted)return;root.dataset.reviewMounted='true';
  const filter=()=>{const q=(root.querySelector('[data-review-search-input]')?.value||'').trim().toLowerCase(),issues=root.querySelector('[data-review-issues-only]')?.checked;let count=0;for(const row of root.querySelectorAll('[data-review-record]')){row.hidden=!!(q&&!row.dataset.reviewSearch.includes(q)||issues&&row.dataset.reviewIssues!=='yes');if(!row.hidden)count++;}const counter=root.querySelector('[data-review-filter-count]');if(counter)counter.textContent=`${count}份合同`;const noMatch=root.querySelector('[data-review-no-match]');if(noMatch)noMatch.hidden=count>0;};
  const totals=()=>{const rows=[...root.querySelectorAll('[data-review-item]')];let amount=0,expense=0,margin=0,unknown=false;rows.forEach((row,index)=>{const a=Number(rowValue(row,'amount')),base=rowValue(row,'margin_before_expense'),e=Number(row.dataset.reviewExpense||0),newDelivery=!row.dataset.reviewId&&['实施','交付'].includes(rowValue(row,'kind')),m=base===''?newDelivery?Math.round(a*100):null:Math.round(Number(base)*100);amount+=Math.round(a*100);expense+=e;if(m==null)unknown=true;else margin+=m-e;const n=row.querySelector('[data-review-item-number]');if(n)n.textContent=index+1;const p=row.querySelector('[data-review-margin-preview]');if(p)p.textContent=m==null?'待核对':money(m-e);});const total=root.querySelector('[data-review-item-total]');if(total)total.textContent=`合同合计 ${money(amount)} · 费用 ${money(expense)} · 扣费后毛利 ${unknown?'待核对':money(margin)}`;};
  bindCommittedSearch(root,'[data-review-search-input]',filter);
  root.addEventListener('input',event=>{if(event.target.closest('[data-review-item]'))totals();});
  root.addEventListener('change',event=>{if(event.target.matches('[data-review-issues-only]'))filter();if(event.target.closest('[data-review-item]'))totals();});
  root.addEventListener('click',event=>{const add=event.target.closest('[data-review-add-item]'),remove=event.target.closest('[data-review-remove-item]');if(add){event.preventDefault();root.querySelector('[data-review-items]')?.insertAdjacentHTML('beforeend',itemRow());totals();}if(remove){event.preventDefault();const row=remove.closest('[data-review-item]');if(root.querySelectorAll('[data-review-item]').length===1){const error=root.querySelector('.form-error');if(error)error.textContent='合同至少保留一条明细';return;}row.remove();totals();}});
  totals();
}

const signedMoney=value=>value==null?'待核对':`${value>0?'+':''}${plainMoney(value)}`;
const grade=value=>value==null?'待核对':String(value);
const rate=value=>value!=null&&value!==''&&Number.isFinite(Number(value))?`${(Number(value)*100).toLocaleString('zh-CN',{maximumFractionDigits:2})}%`:'待核对';
const kindLabel={personal:'个人提成',management:'管理提成',legacy:'毛利提成',service:'服务提成',product:'产品提成',margin:'毛利提成'};
function settlementRecord(r){
  return `<details class="review-record review-settlement" ${r.changed||r.pending?'open':''}><summary><strong>${esc(r.sales_name||'销售 #'+r.sales_id)} · ${esc(r.period)} · ${esc(kindLabel[r.kind]||r.kind)}</strong>${badge(r.pending?'待核对':r.changed?'资料有变化':'无变化',r.pending?'warning':r.changed?'blue':'neutral')}</summary><p class="field-help">原确认批次：${r.batch_ids.map(id=>'#'+id).join('、')}${r.last_changed_at?` · 资料变更 ${esc(r.last_changed_at.slice(0,10))}`:''}</p>${r.issues?.length?notice(r.issues.map(i=>esc(i)).join('；')):''}<div class="review-stats"><span>原确认金额<strong>${money(r.confirmed)}</strong></span><span>按原比例现值参考<strong>${money(r.reference)}</strong></span><span>参考差额<strong>${signedMoney(r.difference)}</strong></span></div><div class="table-scroll"><table class="data-table review-table"><thead><tr><th>原结算涉及合同／明细</th><th>原计提基数</th><th>当前基数</th><th>原比例</th><th>现值参考</th><th>核对说明</th></tr></thead><tbody>${r.details.map(d=>`<tr><td>${button(d.contract_no||'HT-'+d.contract_id,'contract',d.contract_id,'ghost')}<span class="record-meta">${esc(d.contract_name||'')} · 明细#${d.item_id} · ${esc(kindLabel[d.component]||d.component)}</span></td><td class="number">${money(d.original_base)}</td><td class="number">${money(d.current_base)}</td><td>${rate(d.rate)}</td><td class="number">${money(d.reference_amount)}</td><td>${esc(d.reason)}</td></tr>`).join('')}</tbody></table></div></details>`;
}
export function settlementReview(S,data){
  const records=data.records||[],performance=data.performance||[],attention=records.filter(r=>r.changed||r.pending),unchanged=records.filter(r=>!r.changed&&!r.pending);
  const performanceRows=[...performance].sort((a,b)=>Number(b.changed)-Number(a.changed)).map(p=>`<tr class="${p.changed?'review-changed':''}"><td>${esc(p.sales_name||'销售 #'+p.sales_id)}<span class="record-meta">${esc(p.period)} · 确认记录#${p.review_id}</span></td><td class="number">${money(p.original_actual)}<span class="record-meta">当前 ${money(p.current_actual)}</span></td><td>${esc(grade(p.original_score))}<span class="record-meta">当前 ${esc(grade(p.current_score))}</span></td><td>${esc(grade(p.original_grade))}<span class="record-meta">当前 ${esc(grade(p.current_grade))}</span></td><td>${badge(p.changed?'有变化':'无变化',p.changed?'blue':'neutral')}<div>${p.contract_ids.map(id=>button('合同#'+id,'contract',id,'ghost')).join('')}</div></td></tr>`).join('');
  return style+heading('结算差额核对','保留原确认记录，查看资料修正对原结算范围的现值参考。',button('迁移资料核对','data-review','','ghost'))+`<div class="drawer-body review-workspace">${notice(esc(data.basis||'按原结算范围和原比例核对现值；参考差额不代表应补发或应追回金额。'))}<div class="review-stats"><span>提成有变化<strong>${records.filter(r=>r.changed&&!r.pending).length}组</strong></span><span>提成待核对<strong>${records.filter(r=>r.pending).length}组</strong></span><span>绩效有变化<strong>${performance.filter(r=>r.changed).length}组</strong></span></div><h3>提成核对</h3>${attention.map(settlementRecord).join('')||'<p class="muted">暂无有变化或待核对的原提成结算。</p>'}${unchanged.length?`<details class="review-section"><summary>查看无变化提成（${unchanged.length}组）</summary>${unchanged.map(settlementRecord).join('')}</details>`:''}<section class="review-section"><h3>已确认绩效对照</h3><p class="field-help">原确认的业绩、分数和等级保持原记录；当前值用于核对资料修正影响。</p><div class="table-scroll"><table class="data-table review-table"><thead><tr><th>销售／月份</th><th>原业绩／当前业绩</th><th>原分数／当前分数</th><th>原等级／当前等级</th><th>核对状态／涉及合同</th></tr></thead><tbody>${performanceRows||'<tr><td colspan="5">暂无已确认绩效</td></tr>'}</tbody></table></div></section><p class="muted">本页仅供核对，原提成确认批次及原绩效快照保持不变。</p></div>`;
}
