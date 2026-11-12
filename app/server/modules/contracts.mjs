import {assertContractDataAccess,canManageContractData} from '../contract-access.mjs';
import {assertExpenseAggregateEditable} from './contract-expenses.mjs';
import {itemProfit} from '../item-profit.mjs';
import {
  assert,
  text,
  choice,
  cents,
  validDate,
  now,
  today,
  code,
  manDays,
  SALE_TYPES,
  ORDER_TYPES,
} from "../domain.mjs";
import { one, all } from "../database.mjs";
import { assertUnsettled, assertOwnershipUnlocked } from "./incentives.mjs";
import {intakeSchema} from '../../public/modules/intake-schema.js';
import {contractSplit} from '../sales-policy.mjs';
import {maintainContract} from './contract-maintenance.mjs';
import {attachContractFile} from './source-records.mjs';
import {validateUpload} from '../ai-intake.mjs';
import {pendingPlans} from '../collection-ledger.mjs';

const renewalTags=['新签（自建）','新签（分发）','续费','经销品'];
const paymentTypes=['客户直付天元','千帆收款'];
const projectStatuses=['交付中','验收中','已验收未结算','已结项','运维中','暂停','续费中'];
const nullableChoice=(value,values,label)=>value===null||value===''?null:choice(value,values,label);
const nullableText=(value,label,max)=>value===null?null:text(value,label,max,false)||null;
function workflowFields(body,db,{actor}) {
  const row={};
  for(const [key,values,label] of [['renewal_tag',renewalTags,'产品续费标签'],['payment_type',paymentTypes,'付款类型'],['project_status',projectStatuses,'项目状态']]){
    if(body[key]===undefined)continue;
    if(key!=='project_status')assertContractDataAccess(actor);
    row[key]=nullableChoice(body[key],values,label);
  }
  for(const [key,label,max] of [['delivery_staff','研发交付人员',500],['project_note','项目备注',3000]])
    if(body[key]!==undefined)row[key]=nullableText(body[key],label,max);
  if(body.collaborator_pm!==undefined){
    assertContractDataAccess(actor);
    if(body.collaborator_pm===null||body.collaborator_pm==='')row.collaborator_pm=null;
    else{
      const id=Number(body.collaborator_pm);
      assert(Number.isSafeInteger(id)&&id>0&&one(db,"SELECT id FROM users WHERE id=? AND role='pm' AND active=1 AND business_member=1 AND developer_admin=0",id),'请选择已有有效项目经理');
      row.collaborator_pm=id;
    }
  }
  return row;
}
// A saved contract is a signed business fact. Filing an optional attachment is
// separate, and must not change another salesperson's linked records.
function syncSignedContract(context,contract,{filing=false}={}){
  const {db,actor,scoped,insert,update}=context,at=now();
  const linked=contract.opportunity_id?one(db,'SELECT * FROM opportunities WHERE id=?',contract.opportunity_id):null;
  const opportunity=linked&&!linked.archived_at&&(actor.role==='admin'||linked.owner_id===actor.id)?scoped('opportunities',linked.id,actor):null;
  if(opportunity){
    assert(opportunity.stage!=='输单','输单商机须核对恢复后再登记已签署合同',409);
    const total=one(db,"SELECT SUM(amount) total FROM contracts WHERE retired_at IS NULL AND opportunity_id=? AND lifecycle!='草稿'",opportunity.id).total;
    assert(opportunity.product_amount===null||opportunity.product_amount<=total,'已签署合同总额低于商机产品金额，请先核对金额');
    if(opportunity.stage!=='赢单')insert('stage_history',{opportunity_id:opportunity.id,from_stage:opportunity.stage,to_stage:'赢单',at});
    update('opportunities',opportunity.id,{stage:'赢单',amount:total,next_action:'跟进合同履约、验收与回款节点',follow_date:null,stage_at:opportunity.stage==='赢单'?opportunity.stage_at:at,updated_at:at});
    insert('activities',{opportunity_id:opportunity.id,user_id:actor.id,source:'系统里程碑',activity_type:'系统',summary:`${filing?'已确认签署合同':'已登记签署合同'} ${contract.contract_no||code('HT',contract.id,contract.created_at)}`,action:'明确交付与回款节点',activity_date:today(),created_at:at});
  }
  const customer=one(db,'SELECT owner_id,status FROM customers WHERE id=?',contract.customer_id);
  if(customer&&!['流失','冻结'].includes(customer.status)&&(actor.role==='admin'||customer.owner_id===actor.id))update('customers',contract.customer_id,{status:'成交',updated_at:at});
}
/** contracts: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleContracts(context) {
  const { path, method, b, actor, db, insert, update, scoped, audit, owner } =
    context;
  let m;
  if((m=path.match(/^\/api\/contracts\/(\d+)\/attachments$/))&&method==='POST'){
    assertContractDataAccess(actor);const c=scoped('contracts',m[1],actor);validateUpload({files:[b.file]});
    const attachmentId=attachContractFile(context,c.id,b.file);
    audit(actor,'直接上传合同附件','contract',c.id,{attachment_id:attachmentId,filename:b.file.name});
    return {id:attachmentId,contract_id:c.id,message:'合同附件已保存，合同签署状态不变'};
  }
  if((m=path.match(/^\/api\/contracts\/(\d+)\/(termination-request|termination)$/))&&method==='POST'){
    const c=scoped('contracts',m[1],actor,'follow');assert(c.lifecycle!=='草稿','草稿可直接删除，无需终止');
    assert(!c.terminated_at,'合同已经终止，账务历史仍保留',409);
    if(m[2]==='termination-request'){
      const reason=text(b.reason,'终止申请原因',1000),pending=one(db,"SELECT id FROM contract_exit_requests WHERE contract_id=? AND status='pending'",c.id);
      if(pending)return {id:pending.id,contract_id:c.id,message:'已有待管理员核对的终止申请'};
      const id=insert('contract_exit_requests',{contract_id:c.id,requested_by:actor.id,reason,status:'pending',created_at:now()});
      audit(actor,'申请终止合同','contract',c.id,{request_id:id,reason});
      return {id,contract_id:c.id,message:'终止申请已提交管理员，合同和账务保持现状'};
    }
    assertContractDataAccess(actor,c);const decision=choice(b.decision||'approved',['approved','rejected'],'核对结果');
    const reason=text(b.reason,'核对说明',1000),request=one(db,"SELECT * FROM contract_exit_requests WHERE contract_id=? AND status='pending'",c.id);
    if(decision==='rejected')assert(request,'没有待处理的终止申请',409);
    else assert(b.confirmed===true,'请确认终止后仍保留原应收、实收及提成历史');
    if(request)update('contract_exit_requests',request.id,{status:decision,reviewed_by:actor.id,reviewed_at:now(),review_note:reason});
    if(decision==='approved')update('contracts',c.id,{terminated_at:now(),termination_reason:reason});
    audit(actor,decision==='approved'?'核对并终止合同（保留账务）':'退回合同终止申请','contract',c.id,{request_id:request?.id||null,reason,amount:c.amount,collected:one(db,"SELECT COALESCE(SUM(amount),0) amount FROM payments WHERE contract_id=? AND status='已到账'",c.id).amount});
    return {id:c.id,message:decision==='approved'?'合同已终止，原应收、实收、计划及提成记录保留；可继续核对历史款项':'终止申请已退回，合同保持原状'};
  }
  if((m=path.match(/^\/api\/contracts\/(\d+)\/maintenance$/))&&method==='PATCH')return maintainContract(context,Number(m[1]));
  if((m=path.match(/^\/api\/contracts\/(\d+)$/))&&method==='DELETE'){
    const c=scoped('contracts',m[1],actor,'follow');
    assertContractDataAccess(actor,c);
    assert(b.data_correction===true||c.lifecycle==='草稿'&&!one(db,"SELECT id FROM payments WHERE contract_id=? AND status='已到账'",c.id),'已归档或已有实收的合同不能删除，请申请终止并保留账务',409);
    assert(b.confirmed===true,'请明确确认删除这份合同订单');
    const reason=text(b.reason,'删除原因',1000);
    assertOwnershipUnlocked(db,c.id,context);
    update('contracts',c.id,{retired_at:now()});
    audit(actor,'删除合同订单','contract',c.id,{reason,contract_no:c.contract_no,amount:c.amount,retained_items:one(db,'SELECT count(*) n FROM contract_items WHERE retired_at IS NULL AND contract_id=?',c.id).n,retained_payments:one(db,'SELECT count(*) n FROM payments WHERE contract_id=?',c.id).n});
    return {id:c.id,message:'合同订单已退出当前业务，历史明细与回款已保留'};
  }
  if (path === "/api/contracts" && method === "POST") {
    assertContractDataAccess(actor);
    assert(actor.role!=='sales'||b.owner_id===undefined||b.owner_id===null||b.owner_id===''||Number(b.owner_id)===actor.id,'销售仅可创建本人归属的合同',403);
    assert(!Object.hasOwn(b,'accept_status'),'旧验收状态字段已退役，请使用项目状态');
    assert(!['recurring_amount','auto_renew'].some(key=>Object.hasOwn(b,key)),'旧续费金额及自动续约字段已退役，请使用产品续费标签与产品到期日');
    const o = b.opportunity_id
      ? scoped("opportunities", b.opportunity_id, actor)
      : null;
    // An authorized existing opportunity retains its original customer link,
    // including migrated records whose customer owner has not yet been aligned.
    const c = o
      ? one(db,"SELECT * FROM customers WHERE id=?",o.customer_id)
      : scoped("customers", b.customer_id, actor);
    assert(c,'关联客户不存在',404);
    assert(b.owner_id||o?.owner_id||c.owner_id,'请选择合同负责人');
    assert(
      !o || b.customer_id === undefined || b.customer_id === null || b.customer_id === "" || Number(b.customer_id) === c.id,
      "关联客户与商机所属客户不一致，请核对后再创建合同",
      409,
    );
    assert(
      !o || o.stage !== '输单' && (o.stage!=='赢单'||b.additional===true||!one(db,'SELECT id FROM contracts WHERE retired_at IS NULL AND opportunity_id=?',o.id)),
      "该商机已结束，不能重复转合同",
      409,
    );
    assert(
      !o || b.additional===true || !one(db, "SELECT id FROM contracts WHERE retired_at IS NULL AND opportunity_id=?", o.id),
      "该商机已有关联合同",
      409,
    );
    assert(
      Array.isArray(b.items) && b.items.length > 0 && b.items.length <= 30,
      "请添加1至30个合同行项",
    );
    const items = b.items.map((i) => {
      assert(i&&typeof i==='object'&&!Array.isArray(i),'合同明细须为产品或服务记录');
      assert(Object.keys(i).every(key=>intakeSchema.contract.itemsSchema.fields.includes(key)),'合同明细包含不支持字段');
      const amount = cents(i.amount, "行项金额");
      const kind = choice(i.kind, ["标品", "实施", "定开", "交付", "运维"], "行项类型");
      return {
        name: text(i.name, "行项名称", 160),
        kind,
        amount,
        rate: null,
        ...itemProfit(i,amount,kind),
        man_days: manDays(i.man_days ?? 0),
        payment_date: validDate(i.payment_date, "预计收款日", true),
        valid_until: validDate(i.valid_until, "到期日", true),
      };
    });
    const amount = items.reduce((s, i) => s + i.amount, 0);
    const signDate = validDate(b.sign_date, '签约日期');
    assert(signDate<=today(),'已签署合同的签约日期不能晚于今天');
    const validUntil = validDate(b.valid_until, '到期日', true);
    assert(!validUntil || validUntil >= signDate, '合同到期日不能早于签约日期');
    if(b.contract_no) assert(!one(db,'SELECT id FROM contracts WHERE retired_at IS NULL AND contract_no=?',text(b.contract_no,'合同编号',80)), '合同编号已存在',409);
    const id = insert("contracts", {
      opportunity_id: o?.id || null,
      customer_id: c.id,
      owner_id: owner(b.owner_id || o?.owner_id || c.owner_id,actor),
      name: text(b.name || o?.name, "合同名称", 160),
      amount,
      sign_date: signDate,
      valid_until: validUntil,
      scope: text(b.scope || "", "交付范围", 3000, false),
      created_at: now(),
      contract_no: b.contract_no ? text(b.contract_no,'合同编号',80) : null,
      collaborator_pm:o?.collaborator_pm||null,
      lifecycle:'已归档',
      commission_policy:'pending',
      sale_type:b.sale_type ? choice(b.sale_type,SALE_TYPES,'销售分类') : o?.sale_type||null,
      order_type:b.order_type ? choice(b.order_type,ORDER_TYPES,'订单类型') : o?.order_type||null,
      ...workflowFields(b,db,{actor}),
    });
    items.forEach((i) => insert("contract_items", { contract_id: id, ...i }));
    syncSignedContract(context,one(db,'SELECT * FROM contracts WHERE id=?',id));
    audit(actor, "创建合同", "contract", id, {
      opportunity_id: o?.id,
      amount,
      signed:true,
      attachment_required:false,
    });
    return { id, message: "合同已保存并确认为已签署，附件可后补，可直接登记收款计划与回款" };
  }
  if((m=path.match(/^\/api\/contracts\/(\d+)\/archive$/))&&method==='POST') {
    assertContractDataAccess(actor);
    const c=scoped('contracts',m[1],actor);
    assert(!(c.lifecycle==='已归档'&&c.archive_attachment_id),'合同签署附件已归档，请勿重复确认',409);
    assert(b.both_stamped===true,'请明确确认合同已经签署');
    assert(!c.terminated_at,'已终止合同不能重新确认签署');
    if(b.file){validateUpload({files:[b.file]});b.archive_attachment_id=attachContractFile(context,c.id,b.file);}
    const provided=b.archive_attachment_id!==undefined&&b.archive_attachment_id!==null&&b.archive_attachment_id!=='';
    assert(c.lifecycle!=='已归档'||provided,'合同已签署，无需重复确认；附件可后补',409);
    let attachment=null;
    if(provided){
      assert((typeof b.archive_attachment_id==='number'||typeof b.archive_attachment_id==='string'&&/^\d+$/.test(b.archive_attachment_id))&&Number.isSafeInteger(Number(b.archive_attachment_id))&&Number(b.archive_attachment_id)>0,'请选择本合同的签署附件');
      attachment=one(db,'SELECT id,mime_type FROM attachments WHERE id=? AND entity=? AND entity_id=?',Number(b.archive_attachment_id),'contract',c.id);
      assert(attachment&&(attachment.mime_type==='application/pdf'||/^image\/(png|jpeg|webp|gif|tiff)$/.test(attachment.mime_type)),'签署附件须为本合同的PDF或图片');
    }
    assert(c.sign_date<=today(),'合同签约日期不能晚于确认签署日期');
    const at=now();
    update('contracts',c.id,{lifecycle:'已归档',...(attachment?{archived_at:at,archived_by:actor.id,archive_attachment_id:attachment.id}:{})});
    if(c.lifecycle!=='已归档')syncSignedContract(context,{...c,lifecycle:'已归档'},{filing:true});
    audit(actor,attachment?'归档合同签署附件':'确认合同已签署','contract',c.id,{signed:true,attachment_id:attachment?.id||null});
    return {id:c.id,message:attachment?'合同已签署，签署附件已归档':'合同已确认签署，附件可后补，可直接登记收款计划与回款'};
  }

  if ((m = path.match(/^\/api\/contracts\/(\d+)$/)) && method === "PATCH") {
    const c = scoped("contracts", m[1], actor, actor.role==='pm'?'follow':'edit');
    assert(b.lifecycle===undefined,'合同签署状态请通过确认签署操作维护');
    assert(canManageContractData(actor)||actor.role==='pm'&&c.collaborator_pm===actor.id,'当前角色无权维护合同资料',403);
    assert(!Object.hasOwn(b,'accept_status'),'旧验收状态字段已退役，请使用项目状态');
    assert(!['recurring_amount','auto_renew'].some(key=>Object.hasOwn(b,key)),'旧续费金额及自动续约字段已退役，请使用产品续费标签与产品到期日');
    const row = {},itemChanges=[];
    if(b.items!==undefined){
      assertContractDataAccess(actor);assertOwnershipUnlocked(db,c.id,context);text(b.reason,'合同明细调整原因',1000);
      const prior=all(db,'SELECT * FROM contract_items WHERE retired_at IS NULL AND contract_id=? ORDER BY id',c.id);
      assert(Array.isArray(b.items)&&b.items.length>0&&(b.data_correction===true||b.items.length>=prior.length)&&b.items.length<=Math.max(30,prior.length),'请逐项维护现有合同明细，不可遗漏或重复');
      const ids=new Set();
      const items=b.items.map(value=>{
        assert(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>['id','name','kind','amount','margin','margin_rate','margin_before_expense','business_expense'].includes(k)),'合同明细包含不支持字段');
        const id=value.id==null?null:Number(value.id),original=id==null?{}:prior.find(i=>i.id===id)||(b.data_correction===true?one(db,'SELECT * FROM contract_items WHERE id=? AND contract_id=?',id,c.id):null);
        assert(original&&(id==null||!ids.has(id)),'合同明细编号不属于当前合同或重复');if(id!=null)ids.add(id);
        const amount=cents(value.amount,'行项金额');
        const profit=itemProfit(value,amount,value.kind,original),margin=profit.margin;
        if(original.id)assertExpenseAggregateEditable(db,original.id,profit.business_expense);
        assert(margin===null||margin<=amount,'毛利不能超过行项金额');
        return {...original,id,contract_id:c.id,name:text(value.name,'行项名称',160),kind:value.kind===original.kind?original.kind:choice(value.kind,['标品','实施','交付','定开','运维'],'行项类型'),amount,...profit};
      });
      assert(b.data_correction===true||prior.every(i=>ids.has(i.id)),'不可遗漏已有合同明细');
      if(b.data_correction===true){text(b.reason,'修正原因',1000);for(const old of prior.filter(i=>!ids.has(i.id)))update('contract_items',old.id,{retired_at:now()});}
      row.amount=b.data_correction===true||items.some(i=>i.id==null||i.amount!==prior.find(p=>p.id===i.id)?.amount)?items.reduce((sum,i)=>sum+i.amount,0):c.amount;
      const split=contractSplit({...c,amount:row.amount},items),receipts=all(db,"SELECT * FROM payments WHERE contract_id=? AND status='已到账'",c.id);
      assert(receipts.reduce((sum,p)=>sum+p.amount,0)<=row.amount,'合同金额不能低于累计实际到账',409);
      if(row.amount!==c.amount)assert(pendingPlans(db,c.id).reduce((sum,p)=>sum+p.remaining_amount,0)<=row.amount-receipts.reduce((sum,p)=>sum+p.amount,0),'合同减额后收款计划超过剩余应收，请先调整或作废余款计划',409);
      const known=receipts.filter(p=>p.product_amount!==null);
      assert(!known.length||split.valid&&known.reduce((sum,p)=>sum+p.product_amount,0)<=split.product&&known.reduce((sum,p)=>sum+p.amount-p.product_amount,0)<=split.service,'合同明细与已有产品／服务回款分配冲突',409);
      for(const item of items){const after={name:item.name,kind:item.kind,amount:item.amount,margin:item.margin,business_expense:item.business_expense,margin_before_expense:item.margin_before_expense,retired_at:null};const id=item.id??insert('contract_items',{contract_id:c.id,...after,rate:null,man_days:0,payment_date:null,valid_until:null});if(item.id)update('contract_items',id,after);itemChanges.push({id,before:prior.find(p=>p.id===id),after});}
    }
    Object.assign(row,workflowFields(b,db,{actor}));
    if(b.opportunity_id!==undefined){assertContractDataAccess(actor);text(b.reason,'商机关联修正原因',1000);row.opportunity_id=b.opportunity_id===''||b.opportunity_id===null?null:Number(b.opportunity_id)===c.opportunity_id?c.opportunity_id:scoped('opportunities',b.opportunity_id,actor).id;const customerId=b.customer_id===undefined?c.customer_id:Number(b.customer_id);assert(!row.opportunity_id||one(db,'SELECT customer_id FROM opportunities WHERE id=?',row.opportunity_id)?.customer_id===customerId,'关联合同客户必须与所选商机一致');}
    if(b.customer_id!==undefined&&Number(b.customer_id)!==c.customer_id){assertContractDataAccess(actor);assertOwnershipUnlocked(db,c.id,context);text(b.reason,'客户关联调整原因',1000);const customer=scoped('customers',b.customer_id,actor);assert(!(b.opportunity_id===undefined?c.opportunity_id:row.opportunity_id)||one(db,'SELECT customer_id FROM opportunities WHERE id=?',b.opportunity_id===undefined?c.opportunity_id:row.opportunity_id)?.customer_id===customer.id,'客户须与关联商机一致，请先核对商机关联',409);row.customer_id=customer.id;}
    if(b.created_at!==undefined){assertContractDataAccess(actor);assertOwnershipUnlocked(db,c.id,context);text(b.reason,'创建时间调整原因',1000);assert(typeof b.created_at==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(b.created_at)&&Number.isFinite(Date.parse(b.created_at))&&Date.parse(b.created_at)<=Date.now(),'创建时间须为不晚于当前的有效时间');row.created_at=new Date(b.created_at).toISOString();}
    if(b.name!==undefined){assertContractDataAccess(actor);row.name=text(b.name,'合同名称',160);}
    if(b.contract_no!==undefined){
      assertContractDataAccess(actor);row.contract_no=nullableText(b.contract_no,'合同编号',80);
      assert(!row.contract_no||!one(db,'SELECT id FROM contracts WHERE retired_at IS NULL AND contract_no=? AND id!=?',row.contract_no,c.id),'合同编号已存在',409);
    }
    if(b.sign_date!==undefined){
      assertContractDataAccess(actor);row.sign_date=validDate(b.sign_date,'签约日期');
      if(row.sign_date!==c.sign_date){
        assertOwnershipUnlocked(db,c.id,context);text(b.reason,'签约日期调整原因',1000);
        assert(c.lifecycle==='草稿'||row.sign_date<=today(),'已归档合同签约日期不能晚于今天');
        const ownerId=b.owner_id===undefined?c.owner_id:Number(b.owner_id);
        assert(b.data_correction===true||c.lifecycle==='草稿'||!one(db,"SELECT id FROM performance_reviews WHERE status='confirmed' AND user_id IN(?,?) AND month IN(?,?)",c.owner_id,ownerId,c.sign_date.slice(0,7),row.sign_date.slice(0,7)),'相关月份绩效已确认，签约日期已锁定',409);
      }
    }
    if(b.owner_id!==undefined&&Number(b.owner_id)!==c.owner_id) {
      assert(actor.role==='admin','销售仅可维护本人归属的合同，变更销售归属请联系管理员',403);assertOwnershipUnlocked(db,c.id,context);text(b.reason,'归属调整原因',500);
      row.owner_id=owner(b.owner_id,actor);
    }
    if(b.sale_type!==undefined){assertContractDataAccess(actor);assertUnsettled(db,c.id,context);row.sale_type=choice(b.sale_type,SALE_TYPES,'销售分类');}
    if(b.order_type!==undefined){assertContractDataAccess(actor);assertUnsettled(db,c.id,context);row.order_type=choice(b.order_type,ORDER_TYPES,'订单类型');}
    if (b.scope !== undefined)
      row.scope = text(b.scope, "交付范围", 3000, false);
    if (b.valid_until !== undefined)
      {assertContractDataAccess(actor);row.valid_until = validDate(b.valid_until, "到期日", true);}
    if(b.valid_until!==undefined||b.sign_date!==undefined){const until=b.valid_until===undefined?c.valid_until:row.valid_until;assert(!until||until>=(row.sign_date||c.sign_date),'合同到期日不能早于签约日期');}
    assert(Object.keys(row).length, "没有可更新内容");
    update("contracts", c.id, row);
    audit(actor, "更新合同", "contract", c.id, {...row,before:Object.fromEntries(Object.keys(row).map(key=>[key,c[key]])),...(itemChanges.length?{items:itemChanges}:{}),...(b.reason!==undefined?{reason:text(b.reason,'变更原因',1000,false)}:{})});
    return { id: c.id, message: "合同已更新" };
  }
  if ((m = path.match(/^\/api\/items\/(\d+)$/)) && method === "PATCH") {
    assertContractDataAccess(actor);
    const i = one(db, "SELECT * FROM contract_items WHERE retired_at IS NULL AND id=?", Number(m[1]));
    assert(i, "行项不存在", 404);
    scoped('contracts',i.contract_id,actor);
    const row = {};
    if(b.name!==undefined)row.name=text(b.name,'行项名称',160);
    if(b.kind!==undefined){
      row.kind=b.kind===i.kind?i.kind:choice(b.kind,['标品','实施','交付','定开','运维'],'行项类型');
      if(row.kind!==i.kind){
        assertUnsettled(db,i.contract_id,context);text(b.reason,'行项分类调整原因',1000);
        const c=scoped('contracts',i.contract_id,actor),items=all(db,'SELECT * FROM contract_items WHERE retired_at IS NULL AND contract_id=?',c.id).map(item=>item.id===i.id?{...item,kind:row.kind}:item);
        const split=contractSplit(c,items);assert(split.valid,'请先核对合同行项分类与金额');
        const known=all(db,"SELECT amount,product_amount FROM payments WHERE contract_id=? AND status='已到账' AND product_amount IS NOT NULL",c.id);
        assert(known.reduce((s,p)=>s+p.product_amount,0)<=split.product&&known.reduce((s,p)=>s+p.amount-p.product_amount,0)<=split.service,'分类变更会与已到账产品/服务分配冲突',409);
      }
    }
    for (const k of ["payment_date", "valid_until"])
      if (b[k] !== undefined) row[k] = validDate(b[k], "行项日期", true);
    if(b.man_days!==undefined) row.man_days=manDays(b.man_days);
    if (b.margin !== undefined || b.margin_rate !== undefined || b.margin_before_expense!==undefined || b.business_expense!==undefined) {
      assertUnsettled(db,i.contract_id,context);
      text(b.reason, "毛利改判原因", 1000);
      Object.assign(row,itemProfit(b,i.amount,row.kind||i.kind,i));
      assertExpenseAggregateEditable(db,i.id,row.business_expense);
    }
    assert(Object.keys(row).length, "没有可更新内容");
    update("contract_items", i.id, row);
    audit(actor, "更新合同行项", "contract", i.contract_id, {
      item_id: i.id,
      before:Object.fromEntries(Object.keys(row).map(key=>[key,i[key]])),
      ...row,
      reason: b.reason || "",
    });
    return { id: i.id, message: "合同行项已更新" };
  }
}
