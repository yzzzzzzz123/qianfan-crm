import {all,one,run} from './database.mjs';
import {assert,now,today} from './domain.mjs';

export const isPlan = p => p.status!=='已到账';
export function planBalance(db,id) {
  const p=one(db,'SELECT * FROM payments WHERE id=?',id);
  if(!p||!isPlan(p))return null;
  const allocated=one(db,'SELECT COALESCE(SUM(amount),0) amount FROM payment_plan_links WHERE plan_id=?',id).amount;
  return {...p,settled_amount:allocated,remaining_amount:p.voided_at?0:p.amount-allocated};
}
export function availableReceipt(db,id) {
  const p=one(db,"SELECT * FROM payments WHERE id=? AND status='已到账'",id);
  if(!p)return null;
  return {...p,unallocated_amount:p.amount-one(db,'SELECT COALESCE(SUM(amount),0) amount FROM payment_plan_links WHERE receipt_id=?',id).amount};
}
export function pendingPlans(db,contractId) {
  return all(db,"SELECT id FROM payments WHERE contract_id=? AND status!='已到账' AND voided_at IS NULL ORDER BY COALESCE(promise_date,'9999-12-31'),id",contractId)
    .map(p=>planBalance(db,p.id)).filter(p=>p.remaining_amount>0);
}
export function addPlanLink(ctx,planId,receiptId,amount) {
  const plan=planBalance(ctx.db,planId),receipt=availableReceipt(ctx.db,receiptId);
  assert(plan&&!plan.voided_at&&plan.remaining_amount>0,'该计划已核销或作废，请刷新后重试',409);
  assert(receipt&&receipt.contract_id===plan.contract_id,'只能用本合同的实际到账核销计划');
  assert(Number.isSafeInteger(amount)&&amount>0&&amount<=plan.remaining_amount&&amount<=receipt.unallocated_amount,'核销金额超过计划余款或本笔未分配实收');
  const previous=one(ctx.db,'SELECT * FROM payment_plan_links WHERE plan_id=? AND receipt_id=?',planId,receiptId);
  if(previous)run(ctx.db,'UPDATE payment_plan_links SET amount=amount+? WHERE id=?',amount,previous.id);
  else ctx.insert('payment_plan_links',{plan_id:planId,receipt_id:receiptId,amount,created_at:now(),created_by:ctx.actor.id});
  return {plan_id:planId,receipt_id:receiptId,amount};
}
export function reconcileReceipt(ctx,contractId,receiptId,selectedPlanId) {
  const receipt=availableReceipt(ctx.db,receiptId);let remaining=receipt.unallocated_amount;
  const plans=selectedPlanId?pendingPlans(ctx.db,contractId).filter(p=>p.id===Number(selectedPlanId)):pendingPlans(ctx.db,contractId);
  if(selectedPlanId){assert(plans.length,'请选择本合同尚未核销的收款计划');assert(remaining<=plans[0].remaining_amount,'本次实收超过所选计划余款，请选择自动匹配或核对本次金额');}
  const links=[];
  for(const plan of plans){if(remaining<=0)break;const amount=Math.min(remaining,plan.remaining_amount);links.push(addPlanLink(ctx,plan.id,receiptId,amount));remaining-=amount;}
  return links;
}
export function assertPlanCapacity(db,contract,amount,exceptId=0) {
  const collected=one(db,"SELECT COALESCE(SUM(amount),0) amount FROM payments WHERE contract_id=? AND status='已到账' AND id!=?",contract.id,exceptId).amount;
  const planned=pendingPlans(db,contract.id).filter(p=>p.id!==exceptId).reduce((s,p)=>s+p.remaining_amount,0);
  const allocated=exceptId?planBalance(db,exceptId)?.settled_amount||0:0;
  assert(amount>=allocated,'计划总金额不能低于已经核销的金额');
  assert(planned+amount-allocated<=contract.amount-collected,'收款计划合计超过未收余额，请调整或作废重复计划',409);
}
export function ledgerPayments(db,contractId,asOf=today()) {
  const rows=all(db,'SELECT * FROM payments WHERE contract_id=? ORDER BY id DESC',contractId);
  return rows.map(p=>{
    const links=all(db,'SELECT * FROM payment_plan_links WHERE plan_id=? OR receipt_id=? ORDER BY id',p.id,p.id);
    if(p.status==='已到账')return {...p,record_type:'receipt',links,unallocated_amount:p.amount-links.reduce((s,l)=>s+l.amount,0),overdue_days:0,escalation:'normal'};
    const settled=links.reduce((s,l)=>s+l.amount,0),remaining=p.voided_at?0:p.amount-settled;
    const days=remaining&&p.promise_date<asOf?Math.max(0,Math.floor((new Date(asOf)-new Date(p.promise_date))/86400000)):0;
    return {...p,raw_status:p.status,record_type:'plan',links,settled_amount:settled,remaining_amount:remaining,
      status:p.voided_at?'已作废':remaining===0?'已核销':p.promise_date&&p.promise_date<asOf?'逾期':'待到账',
      overdue_days:days,escalation:days>=7?'critical':days>0?'warning':remaining&&p.checkpoint_date&&p.checkpoint_date<=asOf?'attention':'normal'};
  });
}
