import {assertContractDataAccess} from '../contract-access.mjs';
import {all,one} from '../database.mjs';
import {assert,cents,text,validDate,now} from '../domain.mjs';

export function assertExpenseAggregateEditable(db,itemId,newAmount){
  const item=one(db,'SELECT business_expense FROM contract_items WHERE id=?',Number(itemId));
  assert(item,'合同明细不存在',404);
  if(newAmount===undefined||Number(newAmount)===item.business_expense)return;
  assert(!one(db,"SELECT id FROM contract_expenses WHERE item_id=? AND deleted_at IS NULL AND entry_kind='detail' LIMIT 1",Number(itemId)),
    '已有合同费用明细，请打开“合同费用支出”调整逐笔费用，合计将自动更新',409);
}

export function expenseDetailCounts(db,contractId){
  return new Map(all(db,"SELECT e.item_id,COUNT(*) count FROM contract_expenses e JOIN contract_items i ON i.id=e.item_id WHERE i.contract_id=? AND e.deleted_at IS NULL AND e.entry_kind='detail' GROUP BY e.item_id",Number(contractId)).map(r=>[r.item_id,r.count]));
}

export function readContractExpenses(ctx,actor,contractId){
  assertContractDataAccess(actor);
  const c=ctx.scoped('contracts',contractId,actor,'history'),items=all(ctx.db,'SELECT * FROM contract_items WHERE contract_id=? AND retired_at IS NULL ORDER BY id',c.id);
  const rows=all(ctx.db,`SELECT e.*,i.contract_id,i.name item_name,i.retired_at item_retired_at,a.filename attachment_name,u.name created_by_name
    FROM contract_expenses e JOIN contract_items i ON i.id=e.item_id LEFT JOIN attachments a ON a.id=e.attachment_id LEFT JOIN users u ON u.id=e.created_by
    WHERE i.contract_id=? ORDER BY COALESCE(e.incurred_on,'9999-12-31') DESC,e.id DESC`,c.id);
  return {contract:{id:c.id,name:c.name,contract_no:c.contract_no,owner_id:c.owner_id,retired_at:c.retired_at},items,expenses:rows.filter(e=>!e.deleted_at&&!e.item_retired_at),deleted_expenses:rows.filter(e=>e.deleted_at),
    attachments:all(ctx.db,"SELECT id,filename FROM attachments WHERE entity='contract' AND entity_id=? ORDER BY id",c.id),
    total:items.reduce((sum,i)=>sum+i.business_expense,0),revision:one(ctx.db,'SELECT revision FROM workspace_revision WHERE id=1').revision};
}

function revision(ctx){
  if(ctx.b.expected_revision===undefined)return;
  assert(Number.isSafeInteger(Number(ctx.b.expected_revision))&&Number(ctx.b.expected_revision)===one(ctx.db,'SELECT revision FROM workspace_revision WHERE id=1').revision,
    '资料已更新，请重新打开合同费用明细后核对再保存',409);
}
function expenseItem(ctx,value,contractId){
  const item=one(ctx.db,'SELECT * FROM contract_items WHERE id=?',Number(value));
  assert(item&&!item.retired_at&&item.contract_id===Number(contractId),'请选择本合同的有效明细');
  // Historical import/seed writers may predate the explicit pre-expense field.
  if(item.margin_before_expense==null&&item.margin!=null){item.margin_before_expense=item.margin+(item.business_expense||0);ctx.update('contract_items',item.id,{margin_before_expense:item.margin_before_expense});}
  return item;
}
function fields(ctx,contractId,original={}){
  const b={...original,...ctx.b};
  const amount=cents(b.amount,'合同费用支出');
  const attachment=b.attachment_id===''||b.attachment_id==null?null:Number(b.attachment_id);
  assert(attachment===null||Number.isSafeInteger(attachment)&&!!one(ctx.db,"SELECT id FROM attachments WHERE id=? AND entity='contract' AND entity_id=?",attachment,contractId),'凭证附件须属于本合同');
  return {amount,description:text(b.description,'费用事由',500),incurred_on:validDate(b.incurred_on,'费用发生日期',true),
    payee:text(b.payee||'','收款方',200,false),reference_no:text(b.reference_no||'','费用凭证号',160,false),attachment_id:attachment,updated_at:now()};
}
export function handleContractExpenses(ctx){
  const {path,method,actor,b,db,admin,scoped,insert,update,audit}=ctx;let m;
  if((m=path.match(/^\/api\/contracts\/(\d+)\/expenses$/))&&method==='POST'){
    assertContractDataAccess(actor);const c=scoped('contracts',m[1],actor),reason=text(b.reason,'费用处理原因',1000);revision(ctx);const item=expenseItem(ctx,b.item_id,c.id);
    assert(Object.keys(b).every(k=>['item_id','amount','description','incurred_on','payee','reference_no','attachment_id','reason','expected_revision'].includes(k)),'费用记录包含不支持字段');
    const row=fields(ctx,c.id),id=insert('contract_expenses',{item_id:item.id,...row,entry_kind:'detail',created_by:actor.id,created_at:now()});
    audit(actor,'新增合同费用支出','contract',c.id,{expense_id:id,item_id:item.id,after:row,reason});return {id,contract_id:c.id,message:'合同费用已保存，费用合计和扣费后毛利已更新'};
  }
  if((m=path.match(/^\/api\/contract-expenses\/(\d+)(?:\/(restore))?$/))&&['PATCH','DELETE','POST'].includes(method)){
    if(method==='POST'&&!m[2]||method!=='POST'&&m[2])return;
    assertContractDataAccess(actor);const old=one(db,'SELECT e.*,i.contract_id FROM contract_expenses e JOIN contract_items i ON i.id=e.item_id WHERE e.id=?',Number(m[1]));assert(old,'合同费用不存在',404);
    const c=scoped('contracts',old.contract_id,actor),reason=text(b.reason,'费用处理原因',1000);revision(ctx);expenseItem(ctx,old.item_id,c.id);
    if(method==='DELETE'){
      assert(!old.deleted_at,'费用已删除',409);assert(b.confirmed===true,'请确认删除本笔费用');
      update('contract_expenses',old.id,{deleted_at:now(),delete_reason:reason,updated_at:now()});audit(actor,'删除合同费用支出','contract',c.id,{expense_id:old.id,before:old,reason});return {id:old.id,contract_id:c.id,message:'合同费用已移入回收站，费用合计和扣费后毛利已更新'};
    }
    if(m[2]){
      assert(old.deleted_at,'费用未删除',409);
      if(old.entry_kind==='aggregate')assert(!one(db,"SELECT id FROM contract_expenses WHERE item_id=? AND entry_kind='aggregate' AND deleted_at IS NULL",old.item_id),'当前已有费用合计记录，请先核对并通过新增明细补齐，避免重复费用',409);
      update('contract_expenses',old.id,{deleted_at:null,delete_reason:'',updated_at:now()});audit(actor,'恢复合同费用支出','contract',c.id,{expense_id:old.id,reason});return {id:old.id,contract_id:c.id,message:'合同费用已恢复，费用合计和扣费后毛利已更新'};
    }
    assert(!old.deleted_at,'费用已删除，请先恢复后再修改',409);
    assert(Object.keys(b).every(k=>['item_id','amount','description','incurred_on','payee','reference_no','attachment_id','reason','expected_revision'].includes(k)),'费用记录包含不支持字段');
    const item=expenseItem(ctx,b.item_id??old.item_id,c.id);
    // The aggregate placeholder becomes a real detail once explicitly reviewed.
    const row={...fields(ctx,c.id,{...old,amount:old.amount/100}),item_id:item.id,entry_kind:'detail'};
    update('contract_expenses',old.id,row);audit(actor,'修改合同费用支出','contract',c.id,{expense_id:old.id,before:old,after:row,reason});return {id:old.id,contract_id:c.id,message:'合同费用已更新，费用合计和扣费后毛利已更新'};
  }
}
