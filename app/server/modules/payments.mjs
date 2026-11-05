import {
  assert,
  text,
  choice,
  cents,
  validDate,
  now,
  today,
} from "../domain.mjs";
import { one,all } from "../database.mjs";
import {contractSplit} from '../sales-policy.mjs';
import {assertUnsettled} from './incentives.mjs';

function allocation(db,c,amount,value,exceptId=0) {
  if(value===undefined||value===null||value==='')return null;
  const product=cents(value,'本笔产品回款金额',true);
  assert(product<=amount,'产品回款不能超过本笔到账金额');
  const split=contractSplit(c,all(db,'SELECT * FROM contract_items WHERE contract_id=?',c.id));
  assert(split.valid,'请先核对合同行项分类与金额');
  const prior=all(db,"SELECT * FROM payments WHERE contract_id=? AND id!=? AND status='已到账'",c.id,exceptId);
  const known=prior.filter(p=>p.product_amount!==null);
  assert(product+known.reduce((s,p)=>s+p.product_amount,0)<=split.product,'累计产品回款不能超过合同产品金额');
  assert(amount-product+known.reduce((s,p)=>s+p.amount-p.product_amount,0)<=split.service,'累计服务回款不能超过合同服务金额');
  return product;
}

/** payments: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handlePayments(context) {
  const { path, method, b, actor, db, insert, update, scoped, admin, audit } =
    context;
  let m;
  if((m=path.match(/^\/api\/payments\/(\d+)\/details$/))&&method==='PATCH'){
    admin(actor);
    const p=one(db,'SELECT * FROM payments WHERE id=?',Number(m[1]));assert(p,'回款不存在',404);
    const original=scoped('contracts',p.contract_id,actor);assertUnsettled(db,original.id);
    const c=b.contract_id===undefined||Number(b.contract_id)===p.contract_id?original:scoped('contracts',b.contract_id,actor);assertUnsettled(db,c.id);
    assert(c.lifecycle!=='草稿','合同草稿不能登记回款',409);
    assert(Object.keys(b).every(k=>['contract_id','amount','product_amount','status','pay_date','promise_date','checkpoint_date','note','reason'].includes(k)),'回款维护包含不支持字段');
    const reason=text(b.reason,'回款变更原因',1000),amount=cents(b.amount,'回款金额'),status=choice(b.status,['待到账','已到账','逾期'],'回款状态');
    const unchanged=amount===p.amount&&status===p.status;
    const pay_date=status==='已到账'?validDate(b.pay_date,'实际到账日期',unchanged&&!p.pay_date):null,promise_date=validDate(b.promise_date,'预计回款日期',status==='已到账'||unchanged&&!p.promise_date);
    assert(!pay_date||pay_date<=today(),'到账日期不能晚于今天');
    assert(status!=='逾期'||promise_date&&promise_date<today()||unchanged&&!p.promise_date&&!promise_date,'逾期计划的承诺付款日须早于今天');
    const received=one(db,"SELECT COALESCE(sum(amount),0) n FROM payments WHERE contract_id=? AND id!=? AND status='已到账'",c.id,p.id).n;
    assert(status!=='已到账'||received+amount<=c.amount,'本次到账金额超过合同未回款金额',409);
    const row={contract_id:c.id,amount,status,pay_date,promise_date,product_amount:allocation(db,c,amount,b.product_amount,p.id),checkpoint_date:validDate(b.checkpoint_date,'检查点',true),note:text(b.note||'','回款说明',1000,false)};
    update('payments',p.id,row);audit(actor,'维护回款','contract',c.id,{payment_id:p.id,before:p,after:row,reason});
    return {id:p.id,message:'回款已更新，合同汇总与未确认提成将按最新流水重算'};
  }
  if((m=path.match(/^\/api\/payments\/(\d+)$/))&&method==='PATCH') {
    admin(actor);
    const p=one(db,'SELECT * FROM payments WHERE id=?',Number(m[1]));assert(p,'回款计划不存在',404);
    scoped('contracts',p.contract_id,actor);
    assert(p.status!=='已到账','已到账流水不可通过计划维护改写',409);
    assert(Object.keys(b).every(k=>['promise_date','checkpoint_date','note','reason'].includes(k)),'计划维护只支持预计回款日期、检查点与备注');
    const row={};
    if(b.promise_date!==undefined){
      row.promise_date=validDate(b.promise_date,'预计回款日期');
      row.status=row.promise_date<today()?'逾期':'待到账';
    }
    if(b.checkpoint_date!==undefined)row.checkpoint_date=validDate(b.checkpoint_date,'检查点',true);
    if(b.note!==undefined)row.note=text(b.note,'回款说明',1000,false);
    assert(Object.keys(row).length,'没有可更新内容');
    const reason=text(b.reason,'计划调整原因',1000);
    update('payments',p.id,row);
    audit(actor,'调整回款计划','contract',p.contract_id,{payment_id:p.id,before:{promise_date:p.promise_date,checkpoint_date:p.checkpoint_date,note:p.note,status:p.status},...row,reason});
    return {id:p.id,message:'回款计划已更新'};
  }
  if (path === "/api/payments" && method === "POST") {
    admin(actor);
    const c = scoped("contracts", b.contract_id, actor);
    assert(c.lifecycle!=='草稿','合同草稿尚未归档，不能登记回款或付款计划',409);
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
    const promiseDate=validDate(b.promise_date,'承诺付款日',status==='已到账');
    assert(!payDate||payDate<=today(),'到账日期不能晚于今天');
    assert(status!=='逾期'||promiseDate<today(),'逾期计划的承诺付款日须早于今天');
    assert(
      status !== "已到账" || sum + amount <= c.amount,
      "本次到账金额超过合同未回款金额",
    );
    const id = insert("payments", {
      contract_id: c.id,
      amount,
      product_amount:allocation(db,c,amount,b.product_amount),
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
    });
    return {
      id,
      message:
        status === "已到账" ? "到账已登记，合同余额已更新" : "回款计划已登记",
    };
  }
  if((m=path.match(/^\/api\/payments\/(\d+)\/checkpoint$/))&&method==='POST') {
    admin(actor);const p=one(db,'SELECT * FROM payments WHERE id=?',Number(m[1]));assert(p,'回款计划不存在',404);assert(p.status!=='已到账','已到账记录无需催办');
    const date=validDate(b.checkpoint_date,'检查点');const reason=text(b.reason,'催办说明',1000);
    update('payments',p.id,{checkpoint_date:date,note:p.note+'\n'+today()+' 催办：'+reason});
    audit(actor,'设置回款检查点','contract',p.contract_id,{payment_id:p.id,date,reason});return {id:p.id,message:'催办检查点已更新'};
  }
  if (
    (m = path.match(/^\/api\/payments\/(\d+)\/receive$/)) &&
    method === "POST"
  ) {
    admin(actor);
    const p = one(db, "SELECT * FROM payments WHERE id=?", Number(m[1]));
    assert(p, "回款计划不存在", 404);
    assert(p.status !== "已到账", "该笔回款已到账", 409);
    const c = scoped("contracts", p.contract_id, actor);
    assert(c.lifecycle!=='草稿','合同草稿尚未归档，不能确认到账',409);
    const sum = one(
      db,
      "SELECT COALESCE(SUM(amount),0) total FROM payments WHERE contract_id=? AND status='已到账'",
      c.id,
    ).total;
    assert(
      sum + p.amount <= c.amount,
      "该计划金额超过合同未回款金额，请核对已有到账记录",
    );
    const payDate=validDate(b.pay_date,'到账日期');assert(payDate<=today(),'到账日期不能晚于今天');
    update("payments", p.id, {
      status: "已到账",
      pay_date:payDate,
      product_amount:allocation(db,c,p.amount,b.product_amount??(p.product_amount===null?null:p.product_amount/100),p.id),
    });
    audit(actor, "确认回款到账", "contract", c.id, {
      payment_id: p.id,
      amount: p.amount,
    });
    return { id: p.id, message: "回款已确认到账" };
  }
  if((m=path.match(/^\/api\/payments\/(\d+)\/allocation$/))&&method==='POST') {
    admin(actor);const p=one(db,'SELECT * FROM payments WHERE id=?',Number(m[1]));assert(p,'回款记录不存在',404);
    const c=scoped('contracts',p.contract_id,actor);assertUnsettled(db,c.id);
    assert(p.status==='已到账','请先确认到账再分配产品回款');
    assert(b.product_amount!==undefined&&b.product_amount!==null&&b.product_amount!=='','请填写本笔产品回款金额，纯服务款可明确填0');
    const reason=text(b.reason,'分配依据',1000);
    const product_amount=allocation(db,c,p.amount,b.product_amount,p.id);
    update('payments',p.id,{product_amount});audit(actor,'分配产品回款','contract',c.id,{payment_id:p.id,product_amount,reason});
    return {id:p.id,message:'本笔产品与服务回款分配已保存'};
  }
}
