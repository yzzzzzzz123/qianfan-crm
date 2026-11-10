import {canManageContract} from './contract-access.js';
import {esc,plainMoney,dateLabel,actionButton as button,input,select,textarea,formShell,empty} from '../ui.js';
const note=text=>`<div class="wide workflow-notice">${text}</div>`;
const stamp=value=>value?new Date(value).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).replaceAll('-','.').slice(0,16):'未记录';
export function expenseWorkspace(S,data){
  const c=data.contract,readonly=!!c.retired_at||!canManageContract(S,c);
  const names=new Map(data.items.map(i=>[i.id,i.name]));
  const row=e=>`<tr><td><strong>${esc(e.description)}</strong><span class="record-meta">${esc(names.get(e.item_id)||e.item_name)}${e.entry_kind==='aggregate'?' · 待补明细':''}</span></td><td>${dateLabel(e.incurred_on)}</td><td>${esc(e.payee||'未填写')}</td><td class="number">${plainMoney(e.amount)}</td><td>${esc(e.reference_no||'未填写')}${e.attachment_id?button(e.attachment_name||'查看凭证','record-attachment',e.attachment_id,'ghost'):''}</td><td>${!readonly?button('修改','expense-edit',e.id,'ghost')+button('删除','expense-delete',e.id,'ghost text-danger'):''}</td></tr>`;
  return `<header class="dialog-head"><div><span class="detail-type">${esc(c.contract_no||'HT-'+c.id)}</span><h2>合同费用支出</h2><p>${esc(c.name)}</p></div><button class="icon-btn" data-action="close" aria-label="关闭">×</button></header><div class="drawer-body" data-expense-contract="${c.id}"><div class="profit-summary"><div><span>费用合计</span><strong>${plainMoney(data.total)}</strong></div><div><span>费用记录</span><strong>${data.expenses.length}笔</strong></div><div><span>有效合同明细</span><strong>${data.items.length}项</strong></div><div><span>扣费后毛利</span><strong>${data.items.some(i=>i.margin==null)?'待核对':plainMoney(data.items.reduce((s,i)=>s+i.margin,0))}</strong></div></div><div class="detail-actionbar">${!readonly?button('新增合同费用','expense-new',c.id,'primary','plus'):''}${button('返回合同','contract',c.id,'ghost')}</div>${data.expenses.some(e=>e.entry_kind==='aggregate')?'<div class="workflow-notice">已有费用合计以“待补明细”保留。拆分已有费用请先修改对应记录；新增费用会叠加到费用合计。</div>':''}<div class="table-scroll"><table class="data-table detail-table"><thead><tr><th>费用事由／合同明细</th><th>发生日期</th><th>收款方</th><th>金额</th><th>凭证（选填）</th><th>操作</th></tr></thead><tbody>${data.expenses.map(row).join('')||'<tr><td colspan="6">暂无合同费用支出</td></tr>'}</tbody></table></div>${data.deleted_expenses.length?`<details class="workflow-closed-plans"><summary>已删除费用（${data.deleted_expenses.length}）</summary>${data.deleted_expenses.map(e=>`<article class="workflow-history-card"><div><strong>${esc(e.description)} · ${plainMoney(e.amount)}</strong><p>${esc(e.item_name)} · ${esc(e.delete_reason)}</p><small>${stamp(e.deleted_at)}</small></div>${!readonly?button('恢复费用','expense-restore',e.id,'ghost'):''}</article>`).join('')}</details>`:''}<p class="muted">费用合计按有效费用记录汇总，扣费后毛利只减一次；凭证号和凭证附件均选填。</p></div>`;
}
export function expenseForm(S,type,id,data){
  if(!canManageContract(S,data.contract)||data.contract.retired_at)return empty('无权维护此合同费用，请确认合同有效且属于可维护范围');
  const old=type==='expense-new'?null:[...data.expenses,...data.deleted_expenses].find(e=>e.id===Number(id));
  const c=data.contract,extra=`<input type="hidden" name="expected_revision" value="${data.revision}"><input type="hidden" name="contract_id" value="${c.id}">`;
  if(['expense-delete','expense-restore'].includes(type)){
    if(!old)return empty('费用记录不存在');
    const restore=type==='expense-restore';
    return formShell(restore?'恢复合同费用':'删除合同费用',c.name,extra+note(`${esc(old.description)} · ${plainMoney(old.amount)}。${restore?'恢复后':'删除后'}费用合计和扣费后毛利会重新计算。`)+textarea('reason','处理原因','',true)+`<label class="wide workflow-check"><input type="checkbox" name="confirmed" required>已核对本笔费用，确认${restore?'恢复':'删除'}</label>`,type,id,restore?'确认恢复费用':'确认删除费用');
  }
  if(type!=='expense-new'&&!old)return empty('费用记录不存在');
  const item=old?.item_id||data.items[0]?.id;
  return formShell(old?'修改合同费用支出':'新增合同费用支出',c.name,extra+
    note('发生日期、收款方、凭证号及凭证附件均可留空。费用按所选合同明细汇总；新增会增加费用，拆分已有合计请先修改旧记录。')+
    select('item_id','对应合同明细',data.items.map(i=>[i.id,`${i.name} · ${plainMoney(i.amount)}`]),item,'required')+
    input('amount','费用金额（元）',old?old.amount/100:'','number',true,'min="0.01" step="0.01"')+
    input('incurred_on','发生日期（选填）',old?.incurred_on||'','date',false)+
    input('payee','收款方（选填）',old?.payee||'','text',false,'maxlength="200"')+
    textarea('description','费用事由',old?.description||'',true)+
    input('reference_no','费用凭证号（选填）',old?.reference_no||'','text',false,'maxlength="160"')+
    select('attachment_id','凭证附件（选填）',[['','不提供凭证附件'],...data.attachments.map(a=>[a.id,a.filename])],old?.attachment_id||'')+
    '<p class="wide field-help">可选择本合同已上传的附件；没有凭证时直接留空即可。</p>'+
    textarea('reason','新增／修改依据','',true),type,old?.id||c.id,'保存合同费用');
}
export function expenseRequest(type,id,values){
  const body={...values};const contractId=Number(body.contract_id);delete body.contract_id;
  if(type==='expense-new')return {path:'/contracts/'+contractId+'/expenses',method:'POST',body,contractId};
  if(type==='expense-edit')return {path:'/contract-expenses/'+id,method:'PATCH',body,contractId};
  if(type==='expense-delete')return {path:'/contract-expenses/'+id,method:'DELETE',body:{reason:body.reason,confirmed:body.confirmed==='on'||body.confirmed===true,expected_revision:body.expected_revision},contractId};
  if(type==='expense-restore')return {path:'/contract-expenses/'+id+'/restore',method:'POST',body:{reason:body.reason,expected_revision:body.expected_revision},contractId};
}
