import {canManageContractData,canManageContract} from './contract-access.js';
import {profitEditor} from './profit-editor.js';
import {canDeleteContract} from './contract-fields.js';
import {contractList,contractFacts,formWorkflow,contractAnalysisPanel,paymentDetails,contractWorkspace,renewalTags,paymentTypes} from './contract-workflow.js';
import {esc,icon,money,plainMoney,dateLabel,userName,salesName,customerName,badge,actionButton as button,sectionHead,empty,select,input,textarea,formShell} from '../ui.js';
import {sum,filtered,metrics,filters} from './shared.js';
const itemKinds=['标品','实施','定开','交付','运维'];
const contractItemKinds=['标品','交付','定开','运维'];
const collectionStatus=c=>c.collection_status||(c.collected<=0?'未回款':c.outstanding>0?'部分回款':'已结清');
const collectBadge=c=>badge(collectionStatus(c),['已结清','完全回款'].includes(collectionStatus(c))?'success':collectionStatus(c)==='部分回款'?'warning':'neutral');
export function contracts(S,P) { return contractList(S,P); }
export function contractDetail(S,id,options={}) {const c=S.contracts.find(c=>c.id===Number(id));return c?contractWorkspace(S,c,options):empty('合同不存在');}
export function contractItemRow(S,index,initial={}) {
  return `<div class="item-row" data-item="${index}"><label class="field">内容<input data-field="name" required value="${esc(initial.name||'')}"></label><label class="field">类型<select data-field="kind" required><option value="">请选择</option>${contractItemKinds.map(k=>`<option ${k===initial.kind?'selected':''}>${k}</option>`).join('')}</select></label><label class="field">金额（元）<input type="number" data-field="amount" required min="0.01" step="0.01" value="${esc(initial.amount??'')}"></label>${profitEditor(initial,'yuan')}<button type="button" class="icon-btn" data-action="remove-item" aria-label="移除此明细">${icon('close')}</button></div>`;
}
export function quoteItemRow(index,initial={}) {
  return `<div class="quote-item-row" data-item="${index}"><label class="field">产品或服务<input data-field="name" required value="${esc(initial.name||'')}"></label><label class="field">类型<select data-field="kind" required><option value="">请选择</option>${itemKinds.map(k=>`<option ${k===initial.kind?'selected':''}>${k}</option>`).join('')}</select></label><label class="field">数量<input type="number" data-field="quantity" required min="0.01" step="0.01" value="${esc(initial.quantity??1)}"></label><label class="field">原价单价（元）<input type="number" data-field="list_price" required min="0" step="0.01" value="${esc(initial.list_price??'')}"></label><label class="field">折扣（%）<input type="number" data-field="discount_percent" required min="0" max="100" step="0.01" value="${esc(initial.discount_percent??100)}"></label><button type="button" class="icon-btn" data-action="remove-quote-item" aria-label="移除此报价明细">${icon('close')}</button></div>`;
}
export function formContracts(S,type,id,options) {
  if(['contract-maintain','contract-project','item-margin','payment-plan','contract-extract'].includes(type))return formWorkflow(S,type,id);
  if(type==='payment-allocation') {if(!canManageContractData(S))return empty('无权分配回款');const c=S.contracts.find(c=>c.payments.some(p=>p.id===Number(id))),p=c?.payments.find(p=>p.id===Number(id));if(!p||!canManageContract(S,c))return empty('回款不存在或无权维护');return formShell('分配本笔产品回款',c.name+' · 本笔到账 '+plainMoney(p.amount),input('product_amount','其中产品回款（元）',p.product_amount==null?'':p.product_amount/100,'number',true,'min="0" step="0.01"')+textarea('reason','分配依据','',true),type,id,'保存回款分配');}
  const {customerOptions}=options;
  if(type==='quote')return formShell('新建报价','',select('opportunity_id','关联商机',[['','请选择商机'],...options.oppOptions],id||'','required')+input('valid_until','有效期至','','date')+`<div class="wide items-editor"><div class="section-head"><h3>报价明细</h3><button type="button" class="btn ghost" data-action="add-quote-item">${icon('plus')}添加明细</button></div><div id="quote-items">${quoteItemRow(0)}</div><p class="quote-total">折后合计 <b id="quote-total">0.00</b> 元</p></div>`+textarea('note','备注'),type,id,'保存报价');
  if(['payment','payment-plan-create','archive-contract'].includes(type))return formWorkflow(S,type,id);
  if(type==='contract'||type==='convert') {
    if(!canManageContractData(S))return empty('无权录入合同');
    const o=type==='convert'?S.opportunities.find(o=>o.id===Number(id)):null;if(type==='convert'&&!o)return empty('商机不存在','请刷新列表后重试。');
    if(o&&S.actor.role!=='admin'&&o.owner_id!==S.actor.id)return empty('无权为此商机新增合同');
    const existing=o&&S.contracts.find(c=>c.opportunity_id===o.id);if(existing)return empty('该商机已有合同','',button('查看合同订单','contract',existing.id,'secondary','contracts'));
    return formShell('新增合同','保存后按已签署合同登记，签章附件可后补。',
      (type==='contract'?select('customer_id','关联客户',[['','请选择客户'],...customerOptions],'','required'):`<div class="wide form-context">${esc(customerName(S,o.customer_id))} · ${esc(o.code)}</div>`)+
      (type==='contract'&&S.actor.role==='admin'?select('owner_id','销售小二',[['','沿用客户销售'],...S.users.filter(u=>u.active&&u.role!=='pm').map(u=>[u.id,u.name])],''):'')+
      input('name','合同名称',o?.name||'')+select('order_type','订单类型',[['','待补充'],'代销','经销','千帆'],o?.order_type||'')+select('renewal_tag','产品续费标签',[['','待补充'],...renewalTags],'')+select('payment_type','付款类型',[['','待补充'],...paymentTypes],'')+input('contract_no','合同编号','','text',false)+input('sign_date','签约日期',S.today,'date')+input('valid_until','产品到期日','','date',false)+textarea('scope','交付范围')+
      `<div class="wide items-editor"><div class="section-head"><h3>合同明细</h3><button type="button" class="btn ghost" data-action="add-item">${icon('plus')}添加明细</button></div><div id="contract-items">${contractItemRow(S,0,{name:o?.name||'',amount:o?o.amount/100:''})}</div><output class="wide workflow-notice" data-profit-contract-preview>填写明细后查看合同金额、合同费用支出和扣费后毛利。</output></div>`,type,id,'保存合同');
  }
}
