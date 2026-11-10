import {canManageContractData,canManageContract} from './contract-access.js';
import {esc,plainMoney,dateLabel,customerName,actionButton as button,input,select,textarea,formShell,empty} from '../ui.js';

export const collectionFormTypes=new Set(['payment','payment-plan-create','collection-receive','payment-maintain','payment-plan','payment-void','payment-reconcile','contract-upload','archive-contract','contract-terminate','contract-meta','contract-items']);
export const isOpenPlan=p=>['待到账','逾期'].includes(p.status)&&!p.voided_at&&(p.remaining_amount??p.amount)>0;
export const planRemaining=p=>p.remaining_amount??p.amount;
export const contractCaption=(S,c)=>`${c.contract_no||c.code} · ${customerName(S,c.customer_id)} · ${c.name} · 未收 ${c.outstanding==null?'待核对':plainMoney(c.outstanding)}`;
const notice=(text,kind='')=>`<div class="wide workflow-notice ${kind}">${text}</div>`;
const context=(S,c)=>c?notice(`<strong>${esc(c.contract_no||c.code)} · ${esc(customerName(S,c.customer_id))}</strong><span>${esc(c.name)} · 合同 ${plainMoney(c.amount)} · 已收 ${c.collected==null?'待核对':plainMoney(c.collected)} · 未收 ${c.outstanding==null?'待核对':plainMoney(c.outstanding)}</span>`):'<div class="wide workflow-notice" id="payment-contract-context">请选择合同后查看可收余额。</div>';
const lockNotice=c=>c.locks?.financial?notice(`${esc(c.locks.message)}${c.locks.periods?.length?` 结算期间：${esc(c.locks.periods.join('、'))}`:''}`,'warning'):'';
const fileInput=(required=false,archive=false)=>`<label class="field wide">${archive?'签章附件（选填，PDF／图片）':'合同附件（PDF／图片／DOCX等）'}，单个不超过10MB${required?'<span class="required">*</span>':''}<input type="file" name="file" accept="${archive?'.pdf,.png,.jpg,.jpeg,.webp':'.pdf,.png,.jpg,.jpeg,.webp,.docx,.txt,.md'}" ${required?'required':''}><small>附件保存到本合同，支持后续补充。</small></label>`;
const duplicateFields=()=>`<section class="wide duplicate-check" hidden><p class="duplicate-description"></p><label class="workflow-check"><input type="checkbox" name="duplicate_confirmed">已核对到账记录，确认是另一笔真实款项</label>${textarea('duplicate_reason','继续登记依据','',false)}</section>`;
const memo=()=>`<details class="wide workflow-extra"><summary>补充备注（选填）</summary>${textarea('note','到账备注')}</details>`;
const receiptPreview=()=>`<div class="wide receipt-preview" aria-live="polite"><strong>保存后的变化</strong><div data-receipt-preview>填写本次金额后，查看实收、合同余额和计划余款。</div></div>`;
function receiptFields(S,c,p){
  const product=c?.product_amount,service=c?.service_amount,pure=product!=null&&service!=null&&(product===0||service===0);
  return input('amount','本次实际到账金额（元）','','number',true,'min="0.01" step="0.01" inputmode="decimal"')+input('pay_date','实际到账日期',S.today,'date')+
    input('product_amount','其中产品款（元）','','number',false,`min="0" step="0.01" inputmode="decimal" ${pure?'readonly':''}`)+
    `<label class="field">其中服务款（元）<input data-service-amount readonly value="待核对"></label>`+
    `<p class="wide field-help">${pure?'纯产品／服务合同自动确定分配。':'混合回款请按实际情况填写产品款；服务款自动计算。分配未知可先入账，形成提成核对待办。'}</p>`+
    input('reference_no','银行流水号／凭证号（选填）','','text',false,'maxlength="160"')+
    (p?`<label class="field">余款预计收款日<input name="remaining_promise_date" type="date" value="${esc(p.promise_date||S.today)}"></label>`:'')+duplicateFields()+receiptPreview()+memo();
}

export function collectionForm(S,type,id){
  const admin=canManageContractData(S),c=S.contracts.find(c=>c.id===Number(id));
  if(['payment','payment-plan-create'].includes(type)){
    if(!admin)return empty('无权登记回款');
    if(c&&!canManageContract(S,c))return empty('无权维护此合同回款');
    const plan=type==='payment-plan-create';
    const contracts=S.contracts.filter(c=>canManageContract(S,c)&&c.lifecycle!=='草稿'&&(!plan||!c.terminated_at)&&(c.outstanding>0||c.outstanding==null));
    if(c&&!contracts.includes(c))return empty('此合同当前不能新增该记录',c.lifecycle==='草稿'?'请先确认这份历史草稿已签署；附件可后补。':c.terminated_at&&plan?'已终止合同不新增收款计划，仍可核对原计划和后续实收。':'合同已结清，可在收款计划与流水中查看历史或核对原记录。',button('返回','close','','secondary'));
    if(!contracts.length)return empty('请先新增合同','新增合同后即可安排收款计划和登记实收；历史草稿需先确认签署。',button('关闭','close','','secondary'));
    const selector=c?`<input type="hidden" name="contract_id" value="${c.id}">${context(S,c)}`:
      `<label class="field wide">筛选合同<input type="search" data-contract-search placeholder="输入合同编号、客户或名称" autocomplete="off"></label>`+
      `<div class="wide">${select('contract_id','关联合同',[['','请选择合同'],...contracts.map(c=>[c.id,contractCaption(S,c)])],'','required')}</div>`+context(S,null);
    const fields=plan?
      input('amount','计划金额（元）','','number',true,'min="0.01" step="0.01"')+input('promise_date','预计收款日','','date')+input('checkpoint_date','催办检查点（选填）','','date',false)+textarea('note','收款条件／备注')+
      '<div class="wide receipt-preview" data-plan-preview aria-live="polite">计划不会计入实际到账，合计不能超过未安排余额。</div>':
      `<input type="hidden" name="status" value="已到账">`+
      `<label class="field wide">对应收款计划<select name="plan_id"><option value="">自动匹配未核销计划（按预计日期）</option>${(c?.payments||[]).filter(isOpenPlan).map(p=>`<option value="${p.id}">计划 #${p.id} · 余款 ${plainMoney(planRemaining(p))} · ${dateLabel(p.promise_date)}</option>`).join('')}</select></label>`+receiptFields(S,c);
    return formShell(plan?'新增收款计划':'登记实际到账',plan?'只安排收款节点，不增加实际到账。':'实收与计划分别保留，保存时按本次金额核销。',selector+(plan?'<input type="hidden" name="status" value="待到账">':'')+fields,type,id,plan?'保存收款计划':'保存实际到账');
  }
  if(type==='collection-receive'){
    const parent=S.contracts.find(c=>c.payments.some(p=>p.id===Number(id))),p=parent?.payments.find(p=>p.id===Number(id));
    if(!canManageContract(S,parent)||!p||!isOpenPlan(p))return empty('此计划已核销、作废或无权登记');
    return formShell('登记本次到账',`${parent.contract_no||parent.code} · 计划 #${p.id}`,
      context(S,parent)+`<div class="wide workflow-plan-context">原约定 ${plainMoney(p.amount)} · 已核销 ${plainMoney(p.settled_amount||0)} · 计划余款 <strong>${plainMoney(planRemaining(p))}</strong> ${button('按计划余款填写','receipt-fill-balance',p.id,'ghost')}</div>`+receiptFields(S,parent,p),type,id,'保存本次到账');
  }
  if(type==='payment-maintain'){
    const parent=S.contracts.find(c=>c.payments.some(p=>p.id===Number(id))),p=parent?.payments.find(p=>p.id===Number(id));
    if(!canManageContract(S,parent)||!p)return empty('此记录仅保留历史，不能改写');
    const received=p.status==='已到账';
    return formShell(received?'纠正到账录入':'调整收款计划',parent.name,context(S,parent)+
      (received?notice('用于修正原录入错误，变更前后与原因会保留。真实退款请保留原收款并另行核对。'):notice(`原计划已核销 ${plainMoney(p.settled_amount||0)}，调整后的计划总额不能低于已核销金额。`))+
      input('amount',received?'本笔实际到账金额（元）':'计划总金额（元）',p.amount/100,'number',true,'min="0.01" step="0.01"')+
      `<input type="hidden" name="status" value="${received?'已到账':p.raw_status||p.status}">`+
      (received?input('product_amount','其中产品款（元）',p.product_amount==null?'':p.product_amount/100,'number',false,'min="0" step="0.01"')+input('pay_date','实际到账日期',p.pay_date||'','date')+input('reference_no','银行流水号／凭证号（选填）',p.reference_no||'','text',false)+duplicateFields():input('promise_date','预计收款日',p.promise_date||'','date')+input('checkpoint_date','催办检查点',p.checkpoint_date||'','date',false))+
      textarea('note','备注',p.note||'')+textarea('reason','录入纠正依据','',true),type,id,'保存并保留变更记录');
  }
  if(['payment-plan','payment-void','payment-reconcile'].includes(type)){
    const parent=S.contracts.find(c=>c.payments.some(p=>p.id===Number(id))),p=parent?.payments.find(p=>p.id===Number(id));
    if(!canManageContract(S,parent)||!p||!isOpenPlan(p))return empty('此计划已核销、作废或无权维护');
    if(type==='payment-plan')return formShell('调整预计收款日',parent.name,context(S,parent)+notice(`计划 #${p.id} · 未核销余款 ${plainMoney(planRemaining(p))}`)+input('promise_date','预计收款日',p.promise_date||'','date')+input('checkpoint_date','催办检查点',p.checkpoint_date||'','date',false)+textarea('note','收款约定',p.note||'')+textarea('reason','改期依据','',true),type,id,'保存改期');
    if(type==='payment-void')return formShell('作废未核销余款',parent.name,context(S,parent)+notice(`仅作废计划 #${p.id} 的未核销余款 ${plainMoney(planRemaining(p))}。已经到账的款项、原计划与核销历史继续保留。`,'warning')+textarea('reason','作废原因','',true)+`<label class="wide workflow-check"><input type="checkbox" name="confirmed" required>已核对，该余款计划不再作为有效催收依据</label>`,type,id,'确认作废余款计划');
    const receipts=parent.payments.filter(r=>r.status==='已到账'&&(r.unallocated_amount??r.amount)>0);
    if(!receipts.length)return empty('没有可核销的已有实收','此操作不新增实收。请核对历史流水，或作废重复的余款计划。',button('返回','close','','secondary'));
    return formShell('使用已有到账核销计划',parent.name,context(S,parent)+notice(`计划 #${p.id} · 余款 ${plainMoney(planRemaining(p))}。仅建立核销关系，不再增加实收。`)+select('receipt_id','本合同已有到账',receipts.map(r=>[r.id,`收款 #${r.id} · ${dateLabel(r.pay_date)} · 未核销 ${plainMoney(r.unallocated_amount??r.amount)}${r.reference_no?' · '+r.reference_no:''}`]),receipts[0].id,'required')+input('amount','本次核销金额（元）','','number',true,'min="0.01" step="0.01"')+textarea('reason','回单与计划匹配依据','',true),type,id,'确认关联已有实收');
  }
  if(type==='contract-upload'||type==='archive-contract'){
    if(!canManageContract(S,c)||!c)return empty('无权维护合同附件');
    if(type==='contract-upload')return formShell('上传合同附件',c.name,context(S,c)+fileInput(true),type,id,'保存附件');
    if(c.lifecycle==='已归档'||c.terminated_at)return empty('此合同已签署或终止','可在合同附件中后补资料。');
    const files=(c.attachments||[]).filter(f=>/^(application\/pdf|image\/)/i.test(f.mime_type||''));
    return formShell('确认合同已签署',c.name,context(S,c)+(files.length?select('archive_attachment_id','签章附件（选填）',[['','暂不提供，后续补充'],...files.map(f=>[f.id,f.filename])]):'')+fileInput(false,true)+notice('确认后可安排收款计划和登记实际到账。签章附件选填，没有附件也可确认。')+`<label class="wide workflow-check"><input type="checkbox" name="both_stamped" required>确认该合同已签署${c.opportunity_id?'，同步可维护的关联商机':''}</label>`,type,id,'确认签署');
  }
  if(type==='contract-terminate'){
    if(!canManageContract(S,c)||!c||c.lifecycle==='草稿'||c.terminated_at)return empty('此合同无需申请终止');
    const pending=c.termination_request?.status==='pending'?c.termination_request:null;
    return formShell(admin?'核对合同终止':'申请终止合同',c.name,context(S,c)+notice('终止后仍保留原合同金额、应收、实收、计划及已确认提成，不自动撤销历史账务。','warning')+(pending?notice(`${esc(pending.requested_by_name||'成员')}的申请：${esc(pending.reason)}`):'')+
      (admin&&pending?select('decision','核对结果',['approved','rejected'].map(v=>[v,v==='approved'?'同意终止并保留账务':'退回申请，合同保持原状']),'approved'):'')+
      textarea('reason',admin?'财务核对说明':'终止申请原因','',true)+(admin?`<label class="wide workflow-check" data-termination-confirm><input type="checkbox" name="confirmed" required>已核对实收、余款计划及提成影响，同意保留完整账务后终止合同</label>`:''),type,id,admin?'保存核对结果':'提交终止申请');
  }
  return null;
}
