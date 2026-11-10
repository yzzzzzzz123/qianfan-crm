import {canManageContract} from './contract-access.js';
import {profitEditor} from './profit-editor.js';
import {maintenanceForm,maintenanceItem} from './contract-maintenance.js';
import {canDeleteContract} from './contract-fields.js';
import {collectionForm} from './collection-forms.js';
import {esc,input,select,textarea,formShell,empty,actionButton as button} from '../ui.js';
export {contractList,contractFacts,paymentDetails,collectionDetail,collectionsPage,contractWorkspace,contractHistoryList} from './contract-workspace.js';
export {contractAnalysisPanel} from './contract-analysis-view.js';
export const renewalTags=['新签（自建）','新签（分发）','续费','经销品'];
export const paymentTypes=['客户直付天元','千帆收款'];
export const projectStatuses=['交付中','验收中','已验收未结算','已结项','运维中','暂停','续费中'];

export function formWorkflow(S,type,id){
 const special=collectionForm(S,type,id);if(special!==null)return special;
 const c=S.contracts.find(c=>c.id===Number(id)),admin=S.actor.role==='admin',editable=canManageContract(S,c);
 if(type==='contract-delete'){
  if(!c||!canDeleteContract(S,c))return empty('此合同不能删除','请确认该合同仍在当前业务列表且属于可维护范围。',button('返回','close','','secondary'));
  return formShell('删除合同（可恢复）',c.name,textarea('reason','删除原因','',true)+`<label class="wide workflow-check"><input type="checkbox" name="confirmed" required>确认删除此合同，保留账务历史并可恢复</label>`,type,id,'确认删除合同');
 }
 if(type==='contract-meta'){
  if(!editable||!c)return empty('无权修改合同资料');
  const sellers=S.users.filter(u=>(admin||u.id===S.actor.id)&&u.active&&u.role!=='pm'&&u.business_member!==0&&!u.developer_admin);
  const opportunities=S.opportunities.filter(o=>admin||o.owner_id===S.actor.id).map(o=>[o.id,o.name]);if(c.opportunity_id&&!opportunities.some(([id])=>id===c.opportunity_id))opportunities.push([c.opportunity_id,'当前关联商机 #'+c.opportunity_id]);
  const locked=false;
  return formShell('修改合同基本资料',c.contract_no||c.code,
   (locked?`<div class="wide workflow-notice warning">${esc(c.locks.message)}</div>`:'')+
   select('customer_id','关联客户',S.customers.filter(x=>x.id===c.customer_id||admin||x.owner_id===S.actor.id&&!x.shared).map(x=>[x.id,x.short_name||x.name]),c.customer_id)+select('opportunity_id','关联商机',[['','无关联商机'],...opportunities],c.opportunity_id||'')+input('name','合同名称',c.name)+input('contract_no','合同编号',c.contract_no||'','text',false)+
   select('owner_id','销售归属',[['','归属待核对'],...sellers.map(u=>[u.id,u.name])],c.owner_id||'',!admin||locked?'disabled':'')+
   input('sign_date','合同签订日期',c.sign_date,'date',true,locked?'readonly':'')+input('valid_until','产品到期日',c.valid_until||'','date',false)+
   select('order_type','订单类型',[['','待补充'],'代销','经销','千帆'],c.order_type||'')+select('sale_type','销售类型',[['','待补充'],'新签自建','新签分发','续费','增购'],c.sale_type||'')+
   select('renewal_tag','产品续费标签',[['','待补充'],...renewalTags],c.renewal_tag||'')+select('payment_type','付款类型',[['','待补充'],...paymentTypes],c.payment_type||'')+
   textarea('scope','交付范围',c.scope||'')+textarea('reason','修改依据','',true),type,id,'保存基本资料');
 }
 if(type==='contract-project'){
  if(!c||!editable&&!(S.actor.role==='pm'&&c.collaborator_pm===S.actor.id))return empty('无权维护此项目');
  return formShell('维护项目进度',c.name,select('project_status','项目状态',[['','待补充'],...projectStatuses],c.project_status||'')+
   (editable?select('collaborator_pm','项目经理',[['','未指定'],...S.users.filter(u=>u.active&&u.role==='pm').map(u=>[u.id,u.name])],c.collaborator_pm||''):'')+
   input('delivery_staff','研发交付人员',c.delivery_staff||'','text',false)+textarea('project_note','项目进展与备注',c.project_note||'')+textarea('reason','更新依据','',true),type,id,'保存项目进度');
 }
 if(type==='contract-items'){
  if(!editable||!c)return empty('合同明细已锁定或无权修改',c?.locks?.message||'');
  return formShell('调整合同产品与金额',c.name,`<div class="wide workflow-notice">金额由行项合计。合同金额不得低于已收，未核销计划也须与剩余应收一致。</div><section class="wide maintenance-items"><div class="section-head"><h3>合同明细</h3>${button('添加明细','maintenance-add-item','','ghost')}</div><div class="maintenance-item-list">${c.items.map(maintenanceItem).join('')}</div>${c.retired_items?.length?`<details><summary>已移除明细（${c.retired_items.length}）</summary>${c.retired_items.map(i=>`<p>${esc(i.name)} ${button('恢复明细','admin-restore-item',i.id,'ghost')}</p>`).join('')}</details>`:''}<p data-items-summary>合计按明细重算</p></section>`+textarea('reason','调整依据','',true),type,id,'保存明细与金额');
 }
 if(type==='contract-maintain'){
  if(!editable||!c)return empty('无权维护此合同');
  return maintenanceForm(S,type,c,{renewalTags,paymentTypes,projectStatuses});
 }
 if(type==='item-margin'){
  const parent=S.contracts.find(c=>c.items.some(i=>i.id===Number(id))),item=parent?.items.find(i=>i.id===Number(id));
  if(!item||!canManageContract(S,parent))return empty('合同明细已锁定或无权维护',parent?.locks?.message||'');
  return formShell('维护合同明细与毛利',parent.name,input('name','产品／服务名称',item.name)+select('kind','产品类型',[...new Set(['标品','交付','定开','运维',item.kind])],item.kind)+`<input type="hidden" name="amount" value="${item.amount/100}">`+profitEditor(item,'cents','name')+input('payment_date','预计收款日',item.payment_date||'','date',false)+input('valid_until','产品到期日',item.valid_until||'','date',false)+textarea('reason','变更依据','',true),type,id,'保存明细');
 }
 if(type==='contract-extract'){
  if(!editable||!c)return empty('无权读取合同原件');
  const files=(c.attachments||[]).filter(f=>/\.(pdf|png|jpe?g|webp|docx|txt|md)$/i.test(f.filename));
  if(!files.length)return empty('请先上传合同原件','可先上传附件，再按需使用AI辅助提取。',button('上传合同附件','contract-upload',c.id,'secondary'));
  return formShell('提取合同付款约定',c.name,select('attachment_id','合同原件',files.map(f=>[f.id,f.filename]),files[0].id,'required')+'<p class="wide field-help">AI只生成核对建议，不自动认定到账或改写收款计划。</p>',type,id,'开始提取');
 }
 return empty('记录不存在或无权维护','请返回原记录重试。',button('返回','close','','secondary'));
}
