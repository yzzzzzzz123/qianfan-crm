import {assertContractDataAccess} from '../contract-access.mjs';
import {
  assert,
  text,
  choice,
  cents,
  validDate,
  now,
  today,
  AppError,
  code,
} from "../domain.mjs";
import { one,all,run } from "../database.mjs";
import {contractSplit} from '../sales-policy.mjs';
import {assertUnsettled} from './incentives.mjs';
import {planBalance,pendingPlans,assertPlanCapacity,reconcileReceipt,addPlanLink,availableReceipt} from '../collection-ledger.mjs';

function allocation(db,c,amount,value,exceptId=0) {
  const split=contractSplit(c,all(db,'SELECT * FROM contract_items WHERE retired_at IS NULL AND contract_id=?',c.id));
  if(value===undefined||value===null||value===''){
    if(!split.valid||split.product>0&&split.service>0)return null;
    value=split.service===0?amount/100:0;
  }
  const product=cents(value,'本笔产品回款金额',true);
  assert(product<=amount,'产品回款不能超过本笔到账金额');
  assert(split.valid,'请先核对合同行项分类与金额');
  const prior=all(db,"SELECT * FROM payments WHERE contract_id=? AND id!=? AND status='已到账'",c.id,exceptId);
  const known=prior.filter(p=>p.product_amount!==null);
  assert(product+known.reduce((s,p)=>s+p.product_amount,0)<=split.product,'累计产品回款不能超过合同产品金额');
  assert(amount-product+known.reduce((s,p)=>s+p.amount-p.product_amount,0)<=split.service,'累计服务回款不能超过合同服务金额');
  return product;
}

function duplicateCheck(db,c,amount,payDate,reference,b,exceptId=0,actor=null) {
  // A supplied bank reference identifies a receipt across contracts. Without
  // one, keep the existing same-contract amount/date check; a bank slip is not
  // required to record a genuine receipt.
  const duplicate=one(db,`SELECT p.id,p.contract_id,p.amount,p.pay_date,p.reference_no,
      c.contract_no,c.created_at contract_created_at,c.owner_id duplicate_owner_id,cu.name customer_name
    FROM payments p JOIN contracts c ON c.id=p.contract_id
    JOIN customers cu ON cu.id=c.customer_id
    WHERE p.status='已到账' AND p.id!=? AND (
      (?!='' AND p.reference_no=?) OR
      (p.contract_id=? AND p.amount=? AND p.pay_date IS ? AND (?='' OR p.reference_no=''))
    )
    ORDER BY CASE WHEN ?!='' AND p.reference_no=? THEN 0 ELSE 1 END,p.id LIMIT 1`,
    exceptId,reference,reference,c.id,amount,payDate,reference,reference,reference);
  if(!duplicate)return;
  if(b.duplicate_confirmed===true){text(b.duplicate_reason,'款项继续登记依据',1000);return;}
  if(actor?.role==='sales'&&duplicate.duplicate_owner_id!==actor.id)throw Object.assign(new AppError('该银行凭证号已有到账记录，请联系管理员核对；确为另一笔独立款项时填写继续登记依据。',409),{code:'PAYMENT_DUPLICATE'});
  const contractNo=duplicate.contract_no||code('HT',duplicate.contract_id,duplicate.contract_created_at);
  const received=(duplicate.amount/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
  const scope=duplicate.contract_id===c.id?'':'跨合同';
  throw Object.assign(new AppError(`发现${scope}疑似重复到账：合同 ${contractNo}，客户 ${duplicate.customer_name}，收款 #${duplicate.id}，金额 ¥${received}，到账日 ${duplicate.pay_date||'待核对'}。请核对收款记录，确为另一笔独立款项时填写继续登记依据。`,409),{code:'PAYMENT_DUPLICATE'});
}

function createReceipt(ctx,c,amount,payDate,b,planId) {
  const reference=text(b.reference_no||'','银行流水号／凭证号',160,false);
  const collected=one(ctx.db,"SELECT COALESCE(SUM(amount),0) amount FROM payments WHERE contract_id=? AND status='已到账'",c.id).amount;
  assert(collected+amount<=c.amount,'本次到账金额超过合同未回款金额');
  duplicateCheck(ctx.db,c,amount,payDate,reference,b,0,ctx.actor);
  const id=ctx.insert('payments',{contract_id:c.id,amount,status:'已到账',product_amount:allocation(ctx.db,c,amount,b.product_amount),pay_date:payDate,promise_date:null,checkpoint_date:null,reference_no:reference,note:text(b.note||'','回款说明',1000,false),created_at:now()});
  const links=reconcileReceipt(ctx,c.id,id,planId);
  ctx.audit(ctx.actor,'登记实际到账','contract',c.id,{payment_id:id,amount,pay_date:payDate,reference_no:reference,links,...(b.duplicate_confirmed===true?{duplicate_reason:b.duplicate_reason}:{})});
  return {id,links};
}

/** payments: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handlePayments(context) {
  const { path, method, b, actor, db, insert, update, scoped, audit } =
    context;
  let m;
  if((m=path.match(/^\/api\/payments\/(\d+)\/(void-plan|reconcile)$/))&&method==='POST'){
    assertContractDataAccess(actor);const plan=planBalance(db,Number(m[1]));assert(plan,'收款计划不存在',404);
    const c=scoped('contracts',plan.contract_id,actor);
    assert(!plan.voided_at&&plan.remaining_amount>0,'该计划已核销或作废',409);
    const reason=text(b.reason,'核对依据',1000);
    if(m[2]==='void-plan'){
      assert(b.confirmed===true,'请确认仅作废未核销计划，已到账流水保持不变');
      update('payments',plan.id,{voided_at:now(),void_reason:reason});
      audit(actor,'作废收款计划余款','contract',c.id,{plan_id:plan.id,amount:plan.amount,settled_amount:plan.settled_amount,void_amount:plan.remaining_amount,reason});
      return {id:plan.id,message:'未核销余款计划已作废，实际到账与历史核销保留'};
    }
    const receipt=availableReceipt(db,Number(b.receipt_id));
    assert(receipt&&receipt.contract_id===c.id,'请选择本合同已有的实际到账');
    const amount=cents(b.amount,'本次核销金额');const link=addPlanLink(context,plan.id,receipt.id,amount);
    audit(actor,'使用已有到账核销计划','contract',c.id,{...link,reason});
    return {id:plan.id,message:'已有实收已关联收款计划，未重复增加到账金额'};
  }
  if((m=path.match(/^\/api\/payments\/(\d+)\/details$/))&&method==='PATCH'){
    assertContractDataAccess(actor);
    const p=one(db,'SELECT * FROM payments WHERE id=?',Number(m[1]));assert(p,'回款不存在',404);
    const original=scoped('contracts',p.contract_id,actor);
    const c=b.contract_id===undefined||Number(b.contract_id)===p.contract_id?original:scoped('contracts',b.contract_id,actor);
    if(p.status==='已到账'||b.status==='已到账'){assertUnsettled(db,original.id,context);assertUnsettled(db,c.id,context);}
    assert(c.lifecycle!=='草稿','请先确认合同已签署，再维护回款资料',409);
    assert(Object.keys(b).every(k=>['contract_id','amount','product_amount','status','pay_date','promise_date','checkpoint_date','note','reason','reference_no','duplicate_confirmed','duplicate_reason','data_correction'].includes(k)),'回款维护包含不支持字段');
    assert(!p.voided_at,'已作废的计划仅保留历史，不能改写',409);
    const priorLinks=all(db,'SELECT * FROM payment_plan_links WHERE plan_id=? OR receipt_id=? ORDER BY id',p.id,p.id);
    assert(!priorLinks.length||c.id===p.contract_id,'有核销关系的记录不能更换合同，请先核对原流水');
    const reason=text(b.reason,'回款变更原因',1000),amount=cents(b.amount,'回款金额'),status=choice(b.status,['待到账','已到账','逾期'],'回款状态');
    const unchanged=amount===p.amount&&status===p.status;
    const pay_date=status==='已到账'?validDate(b.pay_date,'实际到账日期',unchanged&&!p.pay_date):null,promise_date=validDate(b.promise_date,'预计收款日',status==='已到账'||unchanged&&!p.promise_date);
    assert(!pay_date||pay_date<=today(),'到账日期不能晚于今天');
    assert(status!=='逾期'||promise_date&&promise_date<today()||unchanged&&!p.promise_date&&!promise_date,'逾期计划的预计收款日须早于今天');
    const received=one(db,"SELECT COALESCE(sum(amount),0) n FROM payments WHERE contract_id=? AND id!=? AND status='已到账'",c.id,p.id).n;
    assert(status!=='已到账'||received+amount<=c.amount,'本次到账金额超过合同未回款金额',409);
    assert(!priorLinks.length||status==='已到账'&&p.status==='已到账'||status!=='已到账'&&p.status!=='已到账','已有核销的记录不能更改计划／实收类型，请核对原记录');
    if(status!=='已到账')assertPlanCapacity(db,c,amount,p.id);
    const reference=text(b.reference_no??p.reference_no??'','银行流水号／凭证号',160,false);
    if(status==='已到账')duplicateCheck(db,c,amount,pay_date,reference,b,p.id,actor);
    if(p.status==='已到账'){
      // Reduce existing allocations before reducing cash. Keep their identity,
      // including reconciliations against a subsequently voided remainder.
      let available=amount;
      for(const link of priorLinks.filter(l=>l.receipt_id===p.id)){
        const value=Math.min(available,link.amount);
        if(value===0)run(db,'DELETE FROM payment_plan_links WHERE id=?',link.id);
        else if(value!==link.amount)run(db,'UPDATE payment_plan_links SET amount=? WHERE id=?',value,link.id);
        available-=value;
      }
    }
    const row={contract_id:c.id,amount,status,pay_date,promise_date,reference_no:reference,product_amount:status==='已到账'?allocation(db,c,amount,b.product_amount,p.id):null,checkpoint_date:validDate(b.checkpoint_date,'检查点',true),note:text(b.note||'','回款说明',1000,false)};
    update('payments',p.id,row);audit(actor,'维护回款','contract',c.id,{payment_id:p.id,before:p,after:row,reason,...(b.duplicate_confirmed===true?{duplicate_reason:b.duplicate_reason}:{})});
    if(status==='已到账'){
      reconcileReceipt(context,c.id,p.id);
      if(priorLinks.length)audit(actor,'回款纠错同步核销','contract',c.id,{payment_id:p.id,before_links:priorLinks,after_links:all(db,'SELECT * FROM payment_plan_links WHERE receipt_id=?',p.id),reason});
    }
    return {id:p.id,message:'回款已更新，合同汇总与未确认提成将按最新流水重算'};
  }
  if((m=path.match(/^\/api\/payments\/(\d+)$/))&&method==='PATCH') {
    assertContractDataAccess(actor);
    const p=one(db,'SELECT * FROM payments WHERE id=?',Number(m[1]));assert(p,'收款计划不存在',404);
    scoped('contracts',p.contract_id,actor);
    assert(p.status!=='已到账','已到账流水不可通过计划维护改写',409);
    const plan=planBalance(db,p.id);assert(!p.voided_at&&plan.remaining_amount>0,'该计划已核销或作废，仅保留历史',409);
    assert(Object.keys(b).every(k=>['promise_date','checkpoint_date','note','reason'].includes(k)),'计划维护只支持预计收款日、检查点与备注');
    const row={};
    if(b.promise_date!==undefined){
      row.promise_date=validDate(b.promise_date,'预计收款日');
      row.status=row.promise_date<today()?'逾期':'待到账';
    }
    if(b.checkpoint_date!==undefined)row.checkpoint_date=validDate(b.checkpoint_date,'检查点',true);
    if(b.note!==undefined)row.note=text(b.note,'回款说明',1000,false);
    assert(Object.keys(row).length,'没有可更新内容');
    const reason=text(b.reason,'计划调整原因',1000);
    update('payments',p.id,row);
    audit(actor,'调整收款计划','contract',p.contract_id,{payment_id:p.id,before:{promise_date:p.promise_date,checkpoint_date:p.checkpoint_date,note:p.note,status:p.status},...row,reason});
    return {id:p.id,message:'收款计划已更新'};
  }
  if (path === "/api/payments" && method === "POST") {
    assertContractDataAccess(actor);
    const c = scoped("contracts", b.contract_id, actor);
    assert(c.lifecycle!=='草稿','请先确认合同已签署，再登记回款或收款计划',409);
    const amount = cents(b.amount, "回款金额");
    const status = choice(
      b.status || "已到账",
      ["已到账", "待到账", "逾期"],
      "回款状态",
    );
    const sum = one(
      db,
      "SELECT COALESCE(SUM(amount),0) total FROM payments WHERE contract_id=? AND status='已到账'",
      c.id,
    ).total;
    const payDate=status==='已到账'?validDate(b.pay_date,'到账日期'):null;
    const promiseDate=validDate(b.promise_date,'预计收款日',status==='已到账');
    assert(!payDate||payDate<=today(),'到账日期不能晚于今天');
    assert(status!=='逾期'||promiseDate<today(),'逾期计划的预计收款日须早于今天');
    assert(
      status !== "已到账" || sum + amount <= c.amount,
      "本次到账金额超过合同未回款金额",
    );
    if(status==='已到账'){
      const result=createReceipt(context,c,amount,payDate,b,b.plan_id);
      return {...result,message:result.links.length?'到账已登记，收款计划已按本次金额核销，余款继续保留':'到账已登记，合同余额已更新'};
    }
    assert(!c.terminated_at,'已终止合同不新增收款计划；原计划与后续实收可继续核对',409);
    assertPlanCapacity(db,c,amount);
    const id = insert("payments", {
      contract_id: c.id,
      amount,
      product_amount:null,
      status,
      pay_date:payDate,
      promise_date:promiseDate,
      checkpoint_date: validDate(b.checkpoint_date || b.promise_date, '检查点', true),
      note: text(b.note || "", "回款说明", 1000, false),
      created_at: now(),
    });
    audit(actor, "登记回款", "contract", c.id, {
      payment_id: id,
      amount,
      status,
      after:one(db,'SELECT * FROM payments WHERE id=?',id),
      ...(b.reason?{reason:text(b.reason,'变更原因',1000)}:{}),
    });
    return {
      id,
      message:
        status === "已到账" ? "到账已登记，合同余额已更新" : "收款计划已登记",
    };
  }
  if((m=path.match(/^\/api\/payments\/(\d+)\/checkpoint$/))&&method==='POST') {
    assertContractDataAccess(actor);const p=one(db,'SELECT * FROM payments WHERE id=?',Number(m[1]));assert(p,'收款计划不存在',404);scoped('contracts',p.contract_id,actor);assert(p.status!=='已到账','已到账记录无需催办');
    assert(!p.voided_at&&planBalance(db,p.id).remaining_amount>0,'该计划已核销或作废，无需催办',409);
    const date=validDate(b.checkpoint_date,'检查点');const reason=text(b.reason,'催办说明',1000);
    update('payments',p.id,{checkpoint_date:date,note:p.note+'\n'+today()+' 催办：'+reason});
    audit(actor,'设置回款检查点','contract',p.contract_id,{payment_id:p.id,date,reason});return {id:p.id,message:'催办检查点已更新'};
  }
  if (
    (m = path.match(/^\/api\/payments\/(\d+)\/receive$/)) &&
    method === "POST"
  ) {
    assertContractDataAccess(actor);
    const p = one(db, "SELECT * FROM payments WHERE id=?", Number(m[1]));
    assert(p, "收款计划不存在", 404);
    const c = scoped("contracts", p.contract_id, actor);
    assert(p.status !== "已到账", "该笔回款已到账", 409);
    assert(c.lifecycle!=='草稿','请先确认合同已签署，再确认到账',409);
    const plan=planBalance(db,p.id);assert(!p.voided_at&&plan.remaining_amount>0,'该计划已核销或作废，请勿重复确认',409);
    const amount=b.amount===undefined?plan.remaining_amount:cents(b.amount,'本次实际到账金额');
    assert(amount<=plan.remaining_amount,'本次到账超过该计划未核销余款');
    const sum = one(
      db,
      "SELECT COALESCE(SUM(amount),0) total FROM payments WHERE contract_id=? AND status='已到账'",
      c.id,
    ).total;
    assert(
      sum + amount <= c.amount,
      "该计划金额超过合同未回款金额，请核对已有到账记录",
    );
    const payDate=validDate(b.pay_date,'到账日期');assert(payDate<=today(),'到账日期不能晚于今天');
    const result=createReceipt(context,c,amount,payDate,b,p.id);
    if(amount<plan.remaining_amount&&b.remaining_promise_date!==undefined)update('payments',p.id,{promise_date:validDate(b.remaining_promise_date,'余款预计收款日')});
    audit(actor, "确认回款到账", "contract", c.id, {
      payment_id: result.id,plan_id:p.id,
      amount,remaining_amount:plan.remaining_amount-amount,
    });
    return { ...result,plan_id:p.id,remaining_amount:plan.remaining_amount-amount,message:amount<plan.remaining_amount?'本次到账已登记，余款计划已保留':'回款已确认到账，对应计划已核销' };
  }
  if((m=path.match(/^\/api\/payments\/(\d+)\/allocation$/))&&method==='POST') {
    assertContractDataAccess(actor);const p=one(db,'SELECT * FROM payments WHERE id=?',Number(m[1]));assert(p,'回款记录不存在',404);
    const c=scoped('contracts',p.contract_id,actor);assertUnsettled(db,c.id,context);
    assert(p.status==='已到账','请先确认到账再分配产品回款');
    assert(b.product_amount!==undefined&&b.product_amount!==null&&b.product_amount!=='','请填写本笔产品回款金额，纯服务款可明确填0');
    const reason=text(b.reason,'分配依据',1000);
    const product_amount=allocation(db,c,p.amount,b.product_amount,p.id);
    update('payments',p.id,{product_amount});audit(actor,'分配产品回款','contract',c.id,{payment_id:p.id,product_amount,reason});
    return {id:p.id,message:'本笔产品与服务回款分配已保存'};
  }
}
