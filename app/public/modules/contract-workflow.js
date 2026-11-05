import {maintenanceForm} from './contract-maintenance.js';
import {contractFields,collectionFields,fieldFacts,canDeleteContract} from './contract-fields.js';
import {esc,plainMoney,dateLabel,salesName,customerName,userName,badge,actionButton as button,empty,select,input,textarea,formShell} from '../ui.js';
import {filtered,metrics,filters} from './shared.js';

export const renewalTags=['新签（自建）','新签（分发）','续费','经销品'];
export const paymentTypes=['客户直付天元','千帆收款'];
export const projectStatuses=['交付中','验收中','已验收未结算','已结项','运维中','暂停','续费中'];
const optional=value=>value===null||value===undefined?'待补充':plainMoney(value);
const paymentAllocation=(S,p)=>p.status==='已到账'?`<small class="record-meta">${p.product_amount==null?'产品／服务分配待核对':`产品 ${plainMoney(p.product_amount)} · 服务 ${plainMoney(p.amount-p.product_amount)}`}</small>${S.actor.role==='admin'?button('分配产品回款','payment-allocation',p.id,'ghost','edit'):''}`:'';

export function contractList(S,P){
 const list=filtered(S,P,S.contracts),d=S.contractDashboard||{},month=d.month||S.today.slice(0,7);
 const labels=contractFields(S,{}).map(([label])=>label);
 return `<link rel="stylesheet" href="./modules/contract-workflow.css"><div class="contract-workflow-summary">${metrics([
  ['当月合同总额',optional(d.signed_amount),`${month} · 按合同签订日期`,'contracts'],
  ['当月累计回款',optional(d.received_amount),`${month} · 按实际到账日期`,'wallet'],
  ['待回款金额',optional(d.outstanding_amount),'全部非草稿合同减历史实际到账','clock'],
  ['当月到期合同金额',optional(d.expiring_amount),`${month} · 按产品到期日期`,'calendar'],
  ['逾期计划',optional(d.overdue_amount),'已过承诺付款日且未到账的计划金额','clock']
 ])}</div><section class="panel">${filters(S,P,'contracts')}${list.length?`<div class="table-scroll"><table class="data-table contract-workflow-table"><thead><tr>${[...labels,'操作'].map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${list.map(c=>`<tr class="record-row" tabindex="0" data-action="contract" data-id="${c.id}">${contractFields(S,c).map(([label,value])=>`<td class="${/金额|毛利/.test(label)?'number':''}">${value}</td>`).join('')}<td>${button('查看详情','contract',c.id,'ghost')}${canDeleteContract(S,c)?button('删除合同','contract-delete',c.id,'ghost'):''}</td></tr>`).join('')}</tbody></table></div>`:empty('还没有合同订单','通过手动导入起草合同，原件在AI接收中关联上传。')}<div class="table-footer">共 ${list.length} 份合同订单</div></section>`;
}

export function contractFacts(S,c){return fieldFacts([...contractFields(S,c),['销售类型',esc(c.sale_type||'未提供')]]);}
export function paymentDetails(S,c){
 return `<section class="detail-section"><div class="section-head"><h3>回款明细（${c.payments.length}）</h3>${S.actor.role==='admin'&&c.lifecycle!=='草稿'?button('登记回款','new-payment',c.id,'secondary','wallet'):''}</div><div class="payment-list">${c.payments.map(p=>`<div class="payment-line"><span><b>${plainMoney(p.amount)} · ${esc(p.status)}</b><small class="record-meta">预计 ${dateLabel(p.promise_date)} · 实际 ${p.status==='已到账'?dateLabel(p.pay_date):'未到账'}</small><small class="record-meta">检查点 ${dateLabel(p.checkpoint_date)} · ${esc(p.note||'无备注')}</small>${paymentAllocation(S,p)}</span><span>${S.actor.role==='admin'?button('维护回款','payment-maintain',p.id,'ghost','edit'):''}${S.actor.role==='admin'&&p.status!=='已到账'?button('确认到账','collection-receive',p.id,'ghost','check')+button('维护计划','payment-plan',p.id,'ghost','edit'):''}</span></div>`).join('')||'<p class="muted">尚无回款计划或实际到账</p>'}</div></section>`;
}
export function collectionDetail(S,id){
 const c=(S.collections??S.contracts).find(c=>c.id===Number(id));if(!c)return empty('回款记录不存在');
 return `<link rel="stylesheet" href="./modules/contract-workflow.css"><header class="dialog-head"><div><span class="detail-type">回款管理 · ${esc(c.contract_no||c.code)}</span><h2>${esc(c.name)}</h2></div><button class="icon-btn" data-action="close" aria-label="关闭">关闭</button></header><div class="drawer-body"><div class="detail-actionbar">${S.actor.role==='admin'||S.actor.role==='pm'&&c.collaborator_pm===S.actor.id?button('维护回款资料','contract-project',c.id,'secondary','edit'):''}${button('查看合同','contract',c.id,'ghost')}</div>${fieldFacts(collectionFields(S,c))}${paymentDetails(S,c)}</div>`;
}

export function collectionsPage(S,P){
 const list=filtered(S,P,S.collections??S.contracts).filter(c=>c.lifecycle!=='草稿'&&(!P.contractId||c.id===Number(P.contractId)));
 const labels=collectionFields(S,{}).map(([label])=>label);
 return `<link rel="stylesheet" href="./modules/contract-workflow.css">${P.contractId?`<p class="form-context">正在查看所选合同 ${button('查看全部合同','collections-clear','','ghost')}</p>`:''}<section class="panel">${filters(S,P,'contracts')}${list.length?`<div class="table-scroll"><table class="data-table contract-workflow-table collections-table"><thead><tr>${[...labels,'操作'].map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${list.map(c=>`<tr>${collectionFields(S,c).map(([,value],i)=>`<td>${i===0?button('查看回款详情','collection',c.id,'ghost'):''}${value}</td>`).join('')}<td>${S.actor.role==='admin'?button('登记回款','new-payment',c.id,'secondary','wallet'):''}${S.actor.role==='admin'||S.actor.role==='pm'&&c.collaborator_pm===S.actor.id?button('维护回款资料','contract-project',c.id,'ghost','edit'):''}<details><summary>回款明细（${c.payments.length}）</summary>${paymentDetails(S,c)}</details></td></tr>`).join('')}</tbody></table></div>`:empty('暂无可管理的合同回款','回款必须关联已有的非草稿合同。')}<div class="table-footer">${list.length} 份合同 · 已回款与未回款金额按实际到账自动计算</div></section>`;
}

export function formWorkflow(S,type,id){
 const c=S.contracts.find(c=>c.id===Number(id)),admin=S.actor.role==='admin';
 if(type==='contract-delete'){if(!c||!canDeleteContract(S,c))return empty('无权删除此合同');return formShell('删除合同订单',c.name,`<p class="wide form-context">删除后退出当前合同、回款及未确认统计。合同明细、回款和附件保留用于历史追溯；已确认提成或绩效的合同需先核对。</p>`+textarea('reason','删除原因','',true)+`<label class="wide ai-confirm-check"><input type="checkbox" name="confirmed" required>确认删除这份合同订单及当前业务中的整行关联展示</label>`,type,id,'确认删除');}
 if(type==='contract-extract'){
  if(!admin||!c)return empty('无权提取此合同');
  const files=(c.attachments||[]).filter(f=>/\.(pdf|png|jpe?g|webp|docx|txt|md)$/i.test(f.filename));
  if(!files.length)return empty('请先通过AI接收上传合同原件');
  return formShell('提取合同付款约定',c.name,select('attachment_id','合同原件',files.map(f=>[f.id,f.filename]),files[0].id,'required')+'<p class="wide field-help">AI只读取所选原件，金额与付款阶段将显示为待核对结果。</p>',type,id,'开始提取');
 }
 if(type==='collection-receive'){
  const parent=S.contracts.find(c=>c.payments.some(p=>p.id===Number(id))),p=parent?.payments.find(p=>p.id===Number(id));
  if(!admin||!p||p.status==='已到账')return empty('此计划不能确认到账');
  return formShell('确认回款到账',parent.name+' · 本笔 '+plainMoney(p.amount),input('pay_date','实际回款时间',S.today,'date')+input('product_amount','本笔产品回款金额（元）',p.product_amount==null?'':p.product_amount/100,'number',false,'min="0" step="0.01"')+'<p class="wide field-help">确认实际收到该笔款项后保存；未知产品分配可留空，相关提成保持待核对。</p>',type,id,'确认到账');
 }
 if(type==='contract-maintain'||type==='contract-project'){
  if(!c)return empty('合同不存在');
  if(!admin&&!(type==='contract-project'&&S.actor.role==='pm'&&c.collaborator_pm===S.actor.id))return empty('无权维护此合同');
  if(admin)return maintenanceForm(S,type,c,{renewalTags,paymentTypes,projectStatuses});
  return formShell('维护回款资料',c.name,select('project_status','项目状态',[['','待补充'],...projectStatuses],c.project_status||'')+input('delivery_staff','研发交付人员',c.delivery_staff||'','text',false)+textarea('project_note','项目备注',c.project_note||'')+textarea('reason','变更原因','',true),type,id,'保存修改');
 }
 if(type==='item-margin'){
  const contract=S.contracts.find(c=>c.items.some(i=>i.id===Number(id))),item=contract?.items.find(i=>i.id===Number(id));
  if(!admin||!item)return empty('无权维护此明细');
  return formShell('维护合同明细与毛利',contract.name,input('name','售卖产品／服务',item.name)+select('kind','产品类型',[...new Set(['标品','交付','定开','运维',item.kind])],item.kind)+input('margin','毛利金额（元）',item.margin==null?'':item.margin/100,'number',false,'min="0" step="0.01"')+input('margin_percent','毛利率（%）','','number',false,'min="0" max="100" step="0.01"')+'<p class="wide field-help">可按金额或毛利率维护；两者同时填写须一致。空白保留原值。</p>'+input('payment_date','预计回款日期',item.payment_date||'','date',false)+input('valid_until','产品到期日期',item.valid_until||'','date',false)+textarea('reason','变更依据','',true),type,id,'保存明细');
 }
 if(type==='payment-maintain'){
  const parent=S.contracts.find(c=>c.payments.some(p=>p.id===Number(id))),p=parent?.payments.find(p=>p.id===Number(id));if(!admin||!p)return empty('无权维护此回款');
  return formShell('维护回款',parent.name,`<div class="wide form-context">关联合同 ${esc(parent.contract_no||parent.code)} · ${esc(customerName(S,parent.customer_id))}</div>`+input('amount','本笔回款金额（元）',p.amount/100,'number',true,'min="0.01" step="0.01"')+input('product_amount','其中产品回款（元）',p.product_amount==null?'':p.product_amount/100,'number',false,'min="0" step="0.01"')+select('status','本笔状态',['待到账','已到账','逾期'],p.status)+input('pay_date','实际回款时间',p.pay_date||'','date',p.status==='已到账')+input('promise_date','预计回款时间',p.promise_date||'','date',p.status!=='已到账')+input('checkpoint_date','催办检查点',p.checkpoint_date||'','date',false)+textarea('note','备注',p.note||'',false)+textarea('reason','变更原因','',true),type,id,'保存回款');
 }
 if(type==='payment-plan'){
  const p=S.contracts.flatMap(c=>c.payments).find(p=>p.id===Number(id));if(!admin||!p||p.status==='已到账')return empty('此记录不能修改计划');
  return formShell('维护回款计划',plainMoney(p.amount),input('promise_date','预计回款时间',p.promise_date||'','date')+input('checkpoint_date','催办检查点',p.checkpoint_date||'','date',false)+textarea('note','备注',p.note||'',false)+textarea('reason','修改原因','',true),type,id,'保存计划');
 }
}

export function contractAnalysisPanel(S,c){
 if(S.actor.role==='pm')return '';
 const a=c.contract_analysis,ready=a?.state==='ready',v=a?.result;
 return `<section class="detail-section contract-ai-analysis"><div class="section-head"><h3>合同附件 AI 提取</h3>${S.actor.role==='admin'&&(c.attachments||[]).length?button('重新提取','contract-extract',c.id,'secondary','note'):''}</div>${ready&&v?`<p class="prose">${esc(v.summary||'已读取原件，请核对金额及付款约定。')}</p><dl class="detail-facts"><div><dt>识别合同总金额</dt><dd>${optional(v.total_amount)}</dd></div><div><dt>原始文件</dt><dd>${esc(a.filename||'')}</dd></div></dl><div class="payment-list">${v.payment_stages.map(p=>`<div class="payment-line"><div><b>${esc(p.name)}</b><p>${optional(p.amount)} · ${dateLabel(p.due_date)}</p><p>${esc(p.condition||'')}</p><small>${esc(p.evidence||'')}</small></div></div>`).join('')||'<p class="muted">未识别出明确付款阶段</p>'}</div>${v.questions?.length?`<ul>${v.questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul>`:''}<p class="muted">识别结果需核对，通过业务表单或 AI 接收确认后维护合同及付款计划。</p>`:`<p class="muted">${esc(a?.reason||'通过 AI 接收上传并关联合同原件后，将自动提取合同总金额和约定付款阶段。')}</p>`}</section>`;
}
