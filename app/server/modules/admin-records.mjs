import {assertContractDataAccess} from '../contract-access.mjs';
import {planBalance,assertPlanCapacity} from '../collection-ledger.mjs';
import {all,one,run} from '../database.mjs';
import {assert,text,now} from '../domain.mjs';
import {contractSplit} from '../sales-policy.mjs';

const typeNames={contract:'合同',item:'合同明细',payment:'实际到账',plan:'收款计划',attachment:'合同附件',expense:'合同费用支出'};
const parsePayload=value=>{try{return JSON.parse(value||'{}');}catch{return {};}};
const parameter=(params,key)=>params instanceof URLSearchParams?params.get(key):params?.[key];
function positiveId(value,label){const id=Number(value);assert(Number.isSafeInteger(id)&&id>0,label+'无效');return id;}
function balances(db,contract){
 const collected=one(db,"SELECT COALESCE(SUM(amount),0) amount FROM payments WHERE contract_id=? AND status='已到账'",contract.id).amount;
 const planned=all(db,"SELECT p.id,p.amount,COALESCE(SUM(l.amount),0) settled FROM payments p LEFT JOIN payment_plan_links l ON l.plan_id=p.id WHERE p.contract_id=? AND p.status!='已到账' AND p.voided_at IS NULL GROUP BY p.id",contract.id).reduce((sum,p)=>sum+p.amount-p.settled,0);
 return {contract_amount:contract.amount,collected,outstanding:contract.amount-collected,plan_remaining:planned};
}
function deletionReason(db,contractId,action,at){
 const row=action?one(db,"SELECT detail FROM audit WHERE entity='contract' AND entity_id=? AND action=? ORDER BY id DESC LIMIT 1",contractId,action):one(db,"SELECT detail FROM audit WHERE entity='contract' AND entity_id=? AND action='更新合同' AND created_at>=? ORDER BY id LIMIT 1",contractId,at);
 return parsePayload(row?.detail).reason||'历史删除记录，原原因未记录';
}
function recordFor(db,type,id){
 let row,entry,contract;
 if(type==='contract'){
  row=one(db,'SELECT * FROM contracts WHERE id=? AND retired_at IS NOT NULL',id);if(!row)return null;contract=row;
 }else if(type==='item'){
  row=one(db,'SELECT * FROM contract_items WHERE id=? AND retired_at IS NOT NULL',id);if(!row)return null;contract=one(db,'SELECT * FROM contracts WHERE id=?',row.contract_id);
 }else if(type==='expense'){
  row=one(db,'SELECT e.*,i.contract_id,i.name item_name,i.retired_at item_retired_at FROM contract_expenses e JOIN contract_items i ON i.id=e.item_id WHERE e.id=? AND e.deleted_at IS NOT NULL',id);if(!row)return null;contract=one(db,'SELECT * FROM contracts WHERE id=?',row.contract_id);
 }else{
  entry=one(db,'SELECT * FROM record_recycle_bin WHERE id=? AND restored_at IS NULL',id);if(!entry)return null;row=parsePayload(entry.payload).row;
  if(!row||!['payments','attachments'].includes(entry.entity))return null;
  const actual=entry.entity==='attachments'?'attachment':row.status==='已到账'?'payment':'plan';if(actual!==type)return null;
  contract=one(db,'SELECT * FROM contracts WHERE id=?',entry.contract_id);
 }
 if(!contract)return null;
 const customer=one(db,'SELECT name,short_name FROM customers WHERE id=?',contract.customer_id);
 return {type,id,key:type+':'+id,type_label:typeNames[type],record_id:row.id,contract_id:contract.id,contract_no:contract.contract_no||'HT-'+contract.id,contract_name:contract.name,customer_name:customer?.name||'',name:type==='expense'?row.description:type==='attachment'?row.filename:type==='contract'||type==='item'?row.name:(type==='payment'?'实际到账':'收款计划')+' #'+row.id,
  amount:type==='attachment'?null:row.amount,original_date:type==='contract'?row.sign_date:type==='item'?row.payment_date||null:type==='attachment'?row.created_at:type==='expense'?row.incurred_on:row.pay_date||row.promise_date||null,reference_no:['payment','expense'].includes(type)?row.reference_no||'':'',
  deleted_at:entry?.deleted_at||row.deleted_at||row.retired_at,reason:entry?.reason||row.delete_reason||deletionReason(db,contract.id,type==='contract'?'删除合同订单':null,row.retired_at),
  restore_path:type==='expense'?'/contract-expenses/'+row.id+'/restore':type==='contract'?'/contracts/'+row.id+'/restore':type==='item'?'/items/'+row.id+'/restore':'/record-recycle/'+entry.id+'/restore',parent_deleted:!!contract.retired_at,
  _row:row,_entry:entry,_contract:contract};
}
function safeRecord(record){const {_row,_entry,_contract,...safe}=record;return safe;}
function evaluateRestore(db,record,actor){
 const row=record._row,c=record._contract,before=balances(db,c),after={...before},blockers=[],warnings=[];
 if(record.type!=='contract'&&c.retired_at)blockers.push({code:'PARENT_DELETED',message:'请先恢复所属合同 '+record.contract_no+'，再恢复其明细、回款、费用或附件。',type:'contract',id:c.id});
 if(record.type==='contract'){
  if(c.contract_no&&one(db,'SELECT id FROM contracts WHERE contract_no=? AND retired_at IS NULL AND id!=?',c.contract_no,c.id))blockers.push({code:'CONTRACT_NUMBER_CONFLICT',message:'该合同编号已被其他有效合同使用，请先修正冲突编号。'});
  Object.assign(after,before);Object.assign(before,{contract_amount:0,collected:0,outstanding:0,plan_remaining:0});
 }else if(record.type==='item'){
  const items=all(db,'SELECT * FROM contract_items WHERE contract_id=? AND retired_at IS NULL',c.id),restored=[...items,{...row,retired_at:null}];
  after.contract_amount=restored.reduce((sum,i)=>sum+i.amount,0);after.outstanding=after.contract_amount-after.collected;
  const split=contractSplit({...c,amount:after.contract_amount},restored),known=all(db,"SELECT amount,product_amount FROM payments WHERE contract_id=? AND status='已到账' AND product_amount IS NOT NULL",c.id);
  if(after.outstanding<0)blockers.push({code:'RECEIPTS_EXCEED_CONTRACT',message:'恢复并重新合计明细后，合同金额低于已到账；请先核对当前合同金额和实收。'});
  if(after.plan_remaining>after.outstanding)blockers.push({code:'PLAN_CAPACITY',message:'恢复后的有效计划余款超过合同未收金额，请先调整计划。'});
  if(known.length&&(!split.valid||known.reduce((sum,p)=>sum+p.product_amount,0)>split.product||known.reduce((sum,p)=>sum+p.amount-p.product_amount,0)>split.service))blockers.push({code:'ALLOCATION_CONFLICT',message:'恢复后的产品／服务分类与已有到账分配冲突，请先核对分类或实收分配。'});
 }else if(record.type==='expense'){
  const items=all(db,'SELECT business_expense,margin FROM contract_items WHERE contract_id=? AND retired_at IS NULL',c.id),cost=items.reduce((sum,i)=>sum+(i.business_expense||0),0),margin=items.some(i=>i.margin==null)?null:items.reduce((sum,i)=>sum+i.margin,0);
  Object.assign(before,{contract_expense:cost,net_margin:margin});Object.assign(after,before);
  if(row.item_retired_at)blockers.push({code:'ITEM_DELETED',message:'请先恢复所属合同明细 '+row.item_name+' #'+row.item_id+'，再恢复该笔费用。',type:'item',id:row.item_id});
  else{after.contract_expense+=row.amount;after.net_margin=margin==null?null:margin-row.amount;}
  if(row.entry_kind==='aggregate'&&one(db,"SELECT id FROM contract_expenses WHERE item_id=? AND entry_kind='aggregate' AND deleted_at IS NULL",row.item_id))blockers.push({code:'EXPENSE_AGGREGATE_CONFLICT',message:'当前明细已有费用合计记录，请先核对合计与实际费用，避免重复扣减。'});
 }else{
  const entry=record._entry,payload=parsePayload(entry.payload),table=entry.entity;
  if(one(db,`SELECT id FROM ${table} WHERE id=?`,row.id))blockers.push({code:'RECORD_ID_CONFLICT',message:'原记录编号已被占用，不能覆盖当前记录。'});
  if(record.type==='attachment'){
   if(one(db,"SELECT id FROM attachments WHERE entity='contract' AND entity_id=? AND sha256=?",c.id,row.sha256))blockers.push({code:'ATTACHMENT_DUPLICATE',message:'本合同已有相同内容的附件，请保留现有附件并核对原件。'});
   if(payload.archived){if(c.archive_attachment_id)warnings.push('合同已有新的归档签章件；本次仅恢复为普通附件，不覆盖现有归档依据。');else warnings.push('该文件原为归档签章件，恢复后同时恢复签章件关联。');}
   if(payload.expense_ids?.length)warnings.push('该附件原关联 '+payload.expense_ids.length+' 笔合同费用；仅补回仍属于本合同且尚未重新关联凭证的费用，不覆盖后续修改。');
  }else{
   const links=payload.links||[];
   if(record.type==='payment'){
    after.collected+=row.amount;after.outstanding-=row.amount;
    if(after.outstanding<0)blockers.push({code:'RECEIPTS_EXCEED_CONTRACT',message:'恢复后累计实收超过合同金额，请先核对当前账务。'});
    if(row.product_amount!=null){
     const split=contractSplit(c,all(db,'SELECT * FROM contract_items WHERE contract_id=? AND retired_at IS NULL',c.id));
     const known=all(db,"SELECT amount,product_amount FROM payments WHERE contract_id=? AND status='已到账' AND product_amount IS NOT NULL",c.id);
     if(split.valid&&(row.product_amount+known.reduce((sum,p)=>sum+p.product_amount,0)>split.product||row.amount-row.product_amount+known.reduce((sum,p)=>sum+p.amount-p.product_amount,0)>split.service))blockers.push({code:'ALLOCATION_CONFLICT',message:'恢复后的产品／服务累计实收超过合同对应金额，请先修正分配。'});
    }
   }else if(!row.voided_at){after.plan_remaining+=row.amount-links.reduce((sum,l)=>sum+l.amount,0);if(after.plan_remaining>after.outstanding)blockers.push({code:'PLAN_CAPACITY',message:'恢复计划后余款合计超过合同未收金额，请先调整已重排计划。'});}
   const allocationByOther=new Map();
   for(const link of links){const otherId=record.type==='payment'?link.plan_id:link.receipt_id;allocationByOther.set(otherId,(allocationByOther.get(otherId)||0)+link.amount);}
   for(const [otherId,amount] of allocationByOther){
    const other=one(db,'SELECT * FROM payments WHERE id=?',otherId),otherType=record.type==='payment'?'plan':'payment';
    if(!other){blockers.push({code:'LINKED_RECORD_MISSING',message:(otherType==='plan'?'原关联计划':'原关联实收')+' #'+otherId+' 尚未恢复，请先恢复该记录。',type:otherType,record_id:otherId});continue;}
    if(other.contract_id!==c.id||(record.type==='payment'?other.status==='已到账':other.status!=='已到账')){blockers.push({code:'LINKED_RECORD_CHANGED',message:'原关联记录 #'+otherId+' 的合同或计划／实收类型已变化，请先核对。'});continue;}
    const used=one(db,'SELECT COALESCE(SUM(amount),0) amount FROM payment_plan_links WHERE plan_id=? OR receipt_id=?',otherId,otherId).amount;
    if(used+amount>other.amount)blockers.push({code:'LINK_CAPACITY',message:'原关联记录 #'+otherId+' 的可核销余额已不足，请先核对后续核销。'});
    if(record.type==='payment'&&!other.voided_at)after.plan_remaining-=amount;
   }
   if(record.type==='payment'&&row.reference_no){const duplicate=one(db,"SELECT p.id,c.contract_no,c.owner_id FROM payments p JOIN contracts c ON c.id=p.contract_id WHERE p.status='已到账' AND p.reference_no=? LIMIT 1",row.reference_no);if(duplicate)warnings.push(actor?.role==='sales'&&duplicate.owner_id!==actor.id?'该凭证号已有其他到账记录，请核实是否重复后再恢复。':'现有合同 '+(duplicate.contract_no||'')+' 的收款 #'+duplicate.id+' 使用相同凭证号，请核实是否重复后再恢复。');}
  }
 }
 if(after.plan_remaining>after.outstanding&&!blockers.some(b=>b.code==='PLAN_CAPACITY'))warnings.push('恢复后历史计划余款仍超过未收金额，将保留待核对提示，请人工核销或调整计划。');
 return {before,after,blockers,warnings,can_restore:blockers.length===0};
}

export function readUnifiedRecycle({db},actor,params={}){
 assertContractDataAccess(actor);
 const rawContract=parameter(params,'contract_id'),contractId=rawContract?positiveId(rawContract,'合同编号'):null,q=String(parameter(params,'q')||'').trim().slice(0,200),type=parameter(params,'type')||'';
 assert(!type||Object.hasOwn(typeNames,type),'记录类型无效');
 if(contractId){const contract=one(db,'SELECT * FROM contracts WHERE id=?',contractId);assert(contract,'合同不存在',404);assertContractDataAccess(actor,contract);}
 const candidates=[...all(db,'SELECT id FROM contracts WHERE retired_at IS NOT NULL').map(r=>['contract',r.id]),...all(db,'SELECT id FROM contract_items WHERE retired_at IS NOT NULL').map(r=>['item',r.id]),...all(db,'SELECT id FROM contract_expenses WHERE deleted_at IS NOT NULL').map(r=>['expense',r.id]),...all(db,'SELECT id,entity,payload FROM record_recycle_bin WHERE restored_at IS NULL').map(r=>[r.entity==='attachments'?'attachment':parsePayload(r.payload).row?.status==='已到账'?'payment':'plan',r.id])];
 const words=q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
 let records=candidates.map(([kind,id])=>recordFor(db,kind,id)).filter(Boolean).filter(r=>actor.role==='admin'||r._contract.owner_id===actor.id).filter(r=>(!contractId||r.contract_id===contractId)&&(!type||r.type===type)&&words.every(word=>[r.contract_no,r.contract_name,r.customer_name,r.name,r.reason,r.reference_no,r.amount==null?'':r.amount/100].join(' ').toLocaleLowerCase().includes(word)));
 records.sort((a,b)=>String(b.deleted_at).localeCompare(String(a.deleted_at))||b.id-a.id);
 const total=records.length,limit=Math.min(500,Math.max(1,Number(parameter(params,'limit'))||100)),offset=Math.max(0,Math.floor(Number(parameter(params,'offset'))||0));
 records=records.slice(offset,offset+limit).map(record=>{const evaluation=evaluateRestore(db,record,actor);return {...safeRecord(record),can_restore:evaluation.can_restore,blockers:evaluation.blockers,warnings:evaluation.warnings};});
 return {records,total,limit,offset,filters:{q,type,contract_id:contractId}};
}
export function previewRecycle({db},actor,params={}){
 assertContractDataAccess(actor);const type=parameter(params,'type');assert(Object.hasOwn(typeNames,type),'记录类型无效');const id=positiveId(parameter(params,'id'),'恢复记录编号'),record=recordFor(db,type,id);assert(record,'记录不存在或已经恢复',404);assertContractDataAccess(actor,record._contract);
 return {record:safeRecord(record),...evaluateRestore(db,record,actor)};
}
export function readRecycle({db},actor,contractId){const contract=one(db,'SELECT * FROM contracts WHERE id=?',Number(contractId));assert(contract,'合同不存在',404);assertContractDataAccess(actor,contract);return {records:all(db,'SELECT id,entity,record_id,contract_id,reason,deleted_at FROM record_recycle_bin WHERE restored_at IS NULL AND contract_id=? ORDER BY id DESC',Number(contractId))};}
export function handleAdminRecords(ctx){
 const {path,method,b,actor,db,admin,scoped,insert,update,audit}=ctx;let m;
 if((m=path.match(/^\/api\/payments\/(\d+)\/reopen$/))&&method==='POST'){
  assertContractDataAccess(actor);const p=planBalance(db,Number(m[1]));assert(p?.voided_at,'计划未作废或不存在',404);const c=scoped('contracts',p.contract_id,actor),reason=text(b.reason,'恢复计划原因',1000);assertPlanCapacity(db,c,p.amount,p.id);update('payments',p.id,{voided_at:null,void_reason:''});audit(actor,'恢复作废计划','contract',c.id,{plan_id:p.id,reason,before:p});return {id:c.id,message:'计划已恢复，原核销关系保留'};
 }
 if((m=path.match(/^\/api\/items\/(\d+)\/restore$/))&&method==='POST'){
  assertContractDataAccess(actor);const row=one(db,'SELECT * FROM contract_items WHERE id=?',Number(m[1]));assert(row?.retired_at,'没有可恢复的明细',404);const reason=text(b.reason,'恢复明细原因',1000),preview=previewRecycle(ctx,actor,{type:'item',id:row.id});assert(preview.can_restore,preview.blockers.map(x=>x.message).join(' '),409);scoped('contracts',row.contract_id,actor);
  const rows=all(db,'SELECT * FROM contract_items WHERE contract_id=? AND retired_at IS NULL',row.contract_id);const items=[...rows,row].map(i=>({id:i.id,name:i.name,kind:i.kind,amount:i.amount/100,margin_before_expense:i.margin_before_expense==null?null:i.margin_before_expense/100,business_expense:i.business_expense/100}));
  ctx.mutate('/api/contracts/'+row.contract_id,'PATCH',{items,data_correction:true,reason},actor);return {id:row.contract_id,message:'合同明细已恢复，金额和毛利重新汇总'};
 }
 if((m=path.match(/^\/api\/contracts\/(\d+)\/(restore|resume)$/))&&method==='POST'){
  assertContractDataAccess(actor);const c=one(db,'SELECT * FROM contracts WHERE id=?',Number(m[1]));assert(c,'合同不存在',404);assertContractDataAccess(actor,c);const reason=text(b.reason,'恢复原因',1000);
  if(m[2]==='restore'){assert(c.retired_at,'合同没有删除');const preview=previewRecycle(ctx,actor,{type:'contract',id:c.id});assert(preview.can_restore,preview.blockers.map(x=>x.message).join(' '),409);assert(!c.contract_no||!one(db,'SELECT id FROM contracts WHERE contract_no=? AND retired_at IS NULL AND id!=?',c.contract_no,c.id),'编号已被使用，请先修正冲突编号',409);update('contracts',c.id,{retired_at:null});}
  else {assert(c.terminated_at,'合同没有终止');update('contracts',c.id,{terminated_at:null,termination_reason:''});}
  audit(actor,m[2]==='restore'?'恢复合同':'恢复履约','contract',c.id,{reason,before:c});return {id:c.id,message:'合同已恢复，历史变更记录继续保留'};
 }
 if((m=path.match(/^\/api\/(payments|attachments)\/(\d+)$/))&&method==='DELETE'){
  assertContractDataAccess(actor);const table=m[1],row=one(db,`SELECT * FROM ${table} WHERE id=?`,Number(m[2]));assert(row,'记录不存在',404);
  const contractId=table==='payments'?row.contract_id:row.entity==='contract'?row.entity_id:null;assert(contractId,'仅支持合同附件');scoped('contracts',contractId,actor);
  const reason=text(b.reason,'删除原因',1000);assert(b.confirmed===true,'请确认删除，记录将进入可恢复回收站');
  const links=table==='payments'?all(db,'SELECT * FROM payment_plan_links WHERE plan_id=? OR receipt_id=?',row.id,row.id):[];
  const archived=table==='attachments'&&one(db,'SELECT archive_attachment_id FROM contracts WHERE id=?',contractId).archive_attachment_id===row.id;
  const expenseIds=table==='attachments'?all(db,'SELECT id FROM contract_expenses WHERE attachment_id=?',row.id).map(e=>e.id):[];
  const payload=table==='attachments'?{row:{...row,content:Buffer.from(row.content).toString('base64')},archived,expense_ids:expenseIds}:{row,links};
  const recycle=insert('record_recycle_bin',{entity:table,record_id:row.id,contract_id:contractId,payload:JSON.stringify(payload),reason,deleted_by:actor.id,deleted_at:now()});
  if(table==='payments')run(db,'DELETE FROM payment_plan_links WHERE plan_id=? OR receipt_id=?',row.id,row.id);
  if(archived)update('contracts',contractId,{archive_attachment_id:null});
  if(table==='attachments')run(db,'UPDATE contract_expenses SET attachment_id=NULL,updated_at=? WHERE attachment_id=?',now(),row.id);
  run(db,`DELETE FROM ${table} WHERE id=?`,row.id);audit(actor,'删除并保留恢复快照','contract',contractId,{entity:table,record_id:row.id,recycle_id:recycle,reason,before:table==='attachments'?{filename:row.filename}:row,links});
  return {id:contractId,message:'记录已移入回收站，相关汇总已重算；可在本合同回收站恢复'};
 }
 if((m=path.match(/^\/api\/record-recycle\/(\d+)\/restore$/))&&method==='POST'){
  assertContractDataAccess(actor);const entry=one(db,'SELECT * FROM record_recycle_bin WHERE id=?',Number(m[1]));assert(entry&&!entry.restored_at,'回收记录不存在或已恢复',404);const kind=entry.entity==='attachments'?'attachment':parsePayload(entry.payload).row?.status==='已到账'?'payment':'plan',preview=previewRecycle(ctx,actor,{type:kind,id:entry.id});assert(preview.can_restore,preview.blockers.map(x=>x.message).join(' '),409);scoped('contracts',entry.contract_id,actor);const reason=text(b.reason,'恢复原因',1000),p=JSON.parse(entry.payload);
  assert(!one(db,`SELECT id FROM ${entry.entity} WHERE id=?`,entry.record_id),'原编号已占用，无法覆盖',409);
  if(entry.entity==='payments'){
   const c=one(db,'SELECT amount FROM contracts WHERE id=?',entry.contract_id),collected=one(db,"SELECT COALESCE(SUM(amount),0) n FROM payments WHERE contract_id=? AND status='已到账'",entry.contract_id).n;
   assert(p.row.status!=='已到账'||collected+p.row.amount<=c.amount,'恢复后实收超过合同金额，请先核对当前账务',409);
   for(const link of p.links)assert(one(db,'SELECT id FROM payments WHERE id=?',link.plan_id===p.row.id?link.receipt_id:link.plan_id),'关联记录尚未恢复，请先恢复对应计划或实收',409);
   if(p.row.status!=='已到账'&&!p.row.voided_at){const settled=p.links.reduce((s,l)=>s+l.amount,0);assertPlanCapacity(db,{id:entry.contract_id,amount:c.amount},p.row.amount-settled);}
   insert('payments',p.row);for(const link of p.links){const plan=one(db,'SELECT voided_at FROM payments WHERE id=?',link.plan_id);if(plan.voided_at)update('payments',link.plan_id,{voided_at:null});insert('payment_plan_links',link);if(plan.voided_at)update('payments',link.plan_id,{voided_at:plan.voided_at});}
  }else{insert('attachments',{...p.row,content:Buffer.from(p.row.content,'base64')});for(const expenseId of p.expense_ids||[])run(db,'UPDATE contract_expenses SET attachment_id=?,updated_at=? WHERE id=? AND attachment_id IS NULL AND item_id IN(SELECT id FROM contract_items WHERE contract_id=?)',p.row.id,now(),expenseId,entry.contract_id);if(p.archived&&!one(db,'SELECT archive_attachment_id FROM contracts WHERE id=?',entry.contract_id).archive_attachment_id)update('contracts',entry.contract_id,{archive_attachment_id:p.row.id});}
  update('record_recycle_bin',entry.id,{restored_at:now()});audit(actor,'恢复回收记录','contract',entry.contract_id,{recycle_id:entry.id,record_id:entry.record_id,entity:entry.entity,reason});return {id:entry.contract_id,message:'记录及原关联关系已恢复'};
 }
}
