import {canManageContractData,canManageContract} from './contract-access.js';
import {profitEditor} from './profit-editor.js';
import {canDeleteContract} from './contract-fields.js';
import {contractList,contractFacts,formWorkflow,contractAnalysisPanel,paymentDetails,contractWorkspace,renewalTags,paymentTypes} from './contract-workflow.js';
import {esc,icon,money,plainMoney,dateLabel,userName,salesName,customerName,badge,actionButton as button,sectionHead,empty,select,input,textarea,formShell} from '../ui.js';
import {sum,filtered,metrics,filters} from './shared.js';
const contractItemKinds=['标品','交付','定开','运维'];
const collectionStatus=c=>c.collection_status||(c.collected<=0?'未回款':c.outstanding>0?'部分回款':'已结清');
const collectBadge=c=>badge(collectionStatus(c),['已结清','完全回款'].includes(collectionStatus(c))?'success':collectionStatus(c)==='部分回款'?'warning':'neutral');
export function contracts(S,P) { return contractList(S,P); }
export function contractDetail(S,id,options={}) {const c=S.contracts.find(c=>c.id===Number(id));return c?contractWorkspace(S,c,options):empty('合同不存在');}
export function contractItemRow(S,index,initial={}) {
  return `<div class="item-row" data-item="${index}"><label class="field">内容<input data-field="name" required value="${esc(initial.name||'')}"></label><label class="field">类型<select data-field="kind" required><option value="">请选择</option>${contractItemKinds.map(k=>`<option ${k===initial.kind?'selected':''}>${k}</option>`).join('')}</select></label><label class="field">金额（元）<input type="number" data-field="amount" required min="0.01" step="0.01" value="${esc(initial.amount??'')}"></label>${profitEditor(initial,'yuan')}<button type="button" class="icon-btn" data-action="remove-item" aria-label="移除此明细">${icon('close')}</button></div>`;
}
function conversionItems(S,o) {
  const amount=Object.hasOwn(o,'forecast_amount')?o.forecast_amount:o.amount;
  const product=Object.hasOwn(o,'forecast_product_amount')?o.forecast_product_amount:o.product_amount;
  const quote=S.quotes?.find(q=>q.opportunity_id===o.id&&q.is_current);
  const quoted=quote?.items;
  if(quote&&quote.quote_status!=='当前已过期'&&(!quote.valid_until||quote.valid_until>=S.today)&&Array.isArray(quoted)&&quoted.length&&quoted.length<=30&&
    quoted.every(row=>typeof row?.name==='string'&&row.name.trim()&&contractItemKinds.includes(row.kind)&&Number.isSafeInteger(row.amount)&&row.amount>0)){
    const total=quoted.reduce((sum,row)=>sum+row.amount,0);
    const productTotal=quoted.reduce((sum,row)=>sum+(row.kind==='标品'?row.amount:0),0);
    if(total===quote.amount&&(amount==null||total===amount)&&(product==null||productTotal===product)){
      return {rows:quoted.map(row=>({name:row.name,kind:row.kind,amount:row.amount/100})),hint:'已带出当前报价明细，请按实际签署内容核对。'};
    }
  }
  const name=o.name||'';
  if(!Number.isSafeInteger(amount)||amount<=0)return {rows:[{name}],hint:''};
  const hint='已带出商机预估金额，请按实际签署内容核对。';
  if(!Number.isSafeInteger(product)||product<0||product>amount)return {rows:[{name,amount:amount/100}],hint};
  const rows=[];
  if(product>0)rows.push({name,kind:'标品',amount:product/100});
  if(amount>product)rows.push({name:product>0?'项目服务':name,amount:(amount-product)/100});
  return {rows,hint};
}

function conversionContext(S,o) {
  const pms=S.users.filter(u=>u.role==='pm'&&u.active&&u.business_member!==0&&!u.developer_admin);
  const pm=o.collaborator_pm;
  const currentPm=pms.find(u=>u.id===pm);
  const details=[
    o.customer_name||customerName(S,o.customer_id),
    o.code||o.reference,
    S.actor.role==='sales'&&`销售 ${salesName(S,o)}`,
    o.expected_date&&`预计签约 ${dateLabel(o.expected_date)}`,
    pm&&!currentPm&&`协作 PM ${userName(S,pm)}`,
  ].filter(Boolean);
  const context=`<div class="wide form-context">${esc(details.join(' · '))}</div>`;
  const pmField=!pm||currentPm?select('collaborator_pm','协作 PM',[['','未指定'],...pms.map(u=>[u.id,u.name])],pm||''):'';
  return {context,pmField};
}

export function formContracts(S,type,id,options) {
  if(['contract-maintain','contract-project','item-margin','payment-plan','contract-extract'].includes(type))return formWorkflow(S,type,id);
  if(type==='payment-allocation') {if(!canManageContractData(S))return empty('无权分配回款');const c=S.contracts.find(c=>c.payments.some(p=>p.id===Number(id))),p=c?.payments.find(p=>p.id===Number(id));if(!p||!canManageContract(S,c))return empty('回款不存在或无权维护');return formShell('分配本笔产品回款',c.name+' · 收款 #'+p.id+' · 本笔到账 '+plainMoney(p.amount),input('product_amount','其中产品回款（元）',p.product_amount==null?'':p.product_amount/100,'number',true,'min="0" step="0.01"')+textarea('reason','分配依据','',true),type,id,'保存回款分配');}
  const {customerOptions}=options;
  if(['payment','payment-plan-create','archive-contract'].includes(type))return formWorkflow(S,type,id);
  if(type==='contract'||type==='convert') {
    if(!canManageContractData(S))return empty('无权录入合同');
    const o=type==='convert'?S.opportunities.find(o=>o.id===Number(id)):null;if(type==='convert'&&!o)return empty('商机不存在','请刷新列表后重试。');
    if(o&&S.actor.role!=='admin'&&o.owner_id!==S.actor.id)return empty('无权为此商机新增合同');
    const existing=o&&S.contracts.find(c=>c.opportunity_id===o.id);if(existing)return empty('该商机已有合同','',button('查看合同订单','contract',existing.id,'secondary','contracts'));
    const {rows,hint}=o?conversionItems(S,o):{rows:[{}],hint:''};
    const {context,pmField}=o?conversionContext(S,o):{context:'',pmField:''};
    const sellers=S.users.filter(u=>u.active&&u.role!=='pm'&&u.business_member!==0&&!u.developer_admin);
    const ownerId=sellers.some(u=>u.id===o?.owner_id)?o.owner_id:'';
    const saleType=o?select('sale_type','销售类型',[['','待补充'],'新签自建','新签分发','续费','增购'],o.sale_type||''):'';
    return formShell('新增合同','保存后按已签署合同登记，签章附件可后补。',
      (o?context:select('customer_id','关联客户',[['','请选择客户'],...customerOptions],'','required'))+
      (S.actor.role==='admin'?select('owner_id','销售小二',[['',o?`沿用商机销售（${salesName(S,o)}）`:'沿用客户销售'],...sellers.map(u=>[u.id,u.name])],ownerId):'')+
      input('name','合同名称',o?.name||'')+saleType+select('order_type','订单类型',[['','待补充'],'代销','经销','千帆'],o?.order_type||'')+pmField+
      select('renewal_tag','产品续费标签',[['','待补充'],...renewalTags],'')+select('payment_type','付款类型',[['','待补充'],...paymentTypes],'')+input('contract_no','合同编号','','text',false)+input('sign_date',o?'实际签约日期':'签约日期',o?'':S.today,'date')+input('valid_until','产品到期日','','date',false)+textarea('scope','交付范围')+
      `<div class="wide items-editor"><div class="section-head"><h3>合同明细</h3><button type="button" class="btn ghost" data-action="add-item">${icon('plus')}添加明细</button></div>${hint?`<p class="field-help">${esc(hint)}</p>`:''}<div id="contract-items">${rows.map((row,index)=>contractItemRow(S,index,row)).join('')}</div><output class="wide workflow-notice" data-profit-contract-preview>填写明细后查看合同金额、合同费用支出和扣费后毛利。</output></div>`,type,id,'保存合同');
  }
}
