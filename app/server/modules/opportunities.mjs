import {
  assert,
  text,
  choice,
  cents,
  validDate,
  STAGES,
  SALE_TYPES,
  ORDER_TYPES,
  now,
  today,
} from "../domain.mjs";
import { all, one } from "../database.mjs";
import {assertOwnershipUnlocked} from './incentives.mjs';

/** opportunities: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleOpportunities(context) {
  const { path, method, b, actor, db, insert, update, scoped, owner, audit } =
    context;
  let m;
  if((path==='/api/opportunities'&&method==='POST'||/^\/api\/opportunities\/\d+$/.test(path)&&method==='PATCH'))
    assert(Object.keys(b).every(k=>['customer_id','name','owner_id','stage','amount','product_amount','sale_type','order_type','collaborator_pm','next_action','follow_date','expected_date','lost_reason','reason'].includes(k)),'商机资料包含已停用或不支持的字段');
  if (path === "/api/opportunities" && method === "POST") {
    assert(actor.role !== 'pm','协作PM只能维护关联跟进',403);
    const c = scoped("customers", b.customer_id, actor);
    const stage = choice(
      b.stage || "线索",
      STAGES.filter((s) => !["赢单", "输单"].includes(s)),
      "阶段",
    );
    assert(actor.role!=='admin'||b.owner_id||c.owner_id,'请选择商机负责人');
    const owner_id = owner(b.owner_id || c.owner_id, actor);
    const prefix = 'SJ' + today().slice(0,7).replace('-','');
    const existingRefs=all(db,"SELECT reference FROM opportunities WHERE reference LIKE ?",prefix+'%');
    const seq=Math.max(0,...existingRefs.map(o=>Number(o.reference.slice(prefix.length))||0))+1;
    assert(seq<=999,'本月商机编号已达到三位流水上限');
    const amount=cents(b.amount,'合同总额',true);
    const productAmount=cents(b.product_amount,'cash金额',true);
    assert(productAmount<=amount,'cash金额不能超过合同总额');
    const pm=b.collaborator_pm?Number(b.collaborator_pm):null;
    assert(!pm||one(db,"SELECT id FROM users WHERE id=? AND role='pm' AND active=1 AND business_member=1 AND developer_admin=0",pm),'协作PM无效');
    const id = insert("opportunities", {
      name: text(b.name, "商机名称", 160),
      customer_id: c.id,
      owner_id,
      stage,
      amount,
      product_amount: productAmount,
      sale_type: choice(b.sale_type,SALE_TYPES,'销售分类'),
      order_type: choice(b.order_type,ORDER_TYPES,'订单类型'),
      initial_amount: amount,
      reference: prefix + String(seq).padStart(3,'0'),
      collaborator_pm: pm,
      next_action: text(b.next_action||'', "下一步动作", 500,false),
      follow_date: validDate(b.follow_date, "下次跟进日期",true),
      expected_date: validDate(b.expected_date, "预计到单日期", true),
      stage_at: now(),
      created_at: now(),
      updated_at: now(),
    });
    insert('stage_history',{opportunity_id:id,from_stage:null,to_stage:stage,at:now()});
    audit(actor, "创建商机", "opportunity", id, { name: b.name });
    return { id, message: "商机已创建" };
  }
  if ((m = path.match(/^\/api\/opportunities\/(\d+)$/)) && method === "PATCH") {
    const o = scoped("opportunities", m[1], actor);
    const row = { updated_at: now() };
    if(b.customer_id!==undefined&&Number(b.customer_id)!==o.customer_id){
      assert(!one(db,'SELECT id FROM contracts WHERE retired_at IS NULL AND opportunity_id=?',o.id),'已有关联合同，不能改换商机客户',409);
      row.customer_id=scoped('customers',b.customer_id,actor).id;
    }
    if (b.stage !== undefined) {
      const stage = choice(b.stage, STAGES, "阶段");
      assert(
        stage !== "赢单" || o.stage === "赢单",
        "请先归档双方盖章合同，再确认赢单",
      );
      if (stage !== o.stage) {
        assert(
          !["赢单", "输单"].includes(o.stage),
          "已结束商机不能直接重新推进",
        );
        row.stage = stage;
        row.stage_at = now();
        insert('stage_history',{opportunity_id:o.id,from_stage:o.stage,to_stage:stage,at:now()});
        insert("activities", {
          opportunity_id: o.id,
          user_id: actor.id,
          source: "系统里程碑",
          activity_type: "系统",
          summary: `阶段由「${o.stage}」调整为「${stage}」`,
          action: "",
          activity_date: today(),
          created_at: now(),
        });
      }
    }
    if (row.stage === "输单" || b.lost_reason !== undefined) {
      assert((row.stage || o.stage) === "输单", "仅输单商机可填写流失原因，请先确认商机阶段");
      row.lost_reason = text(b.lost_reason, "流失原因", 1000);
    }
    if (b.owner_id !== undefined && Number(b.owner_id)!==o.owner_id) {
      assert(actor.role==='admin','商机归属仅管理者可调整',403);
      text(b.reason,'归属调整原因',500);row.owner_id=owner(b.owner_id,actor);
      for(const contract of all(db,'SELECT id,owner_id FROM contracts WHERE retired_at IS NULL AND opportunity_id=?',o.id)){
        assertOwnershipUnlocked(db,contract.id);
        update('contracts',contract.id,{owner_id:row.owner_id});
        audit(actor,'随商机移交合同归属','contract',contract.id,{opportunity_id:o.id,before:contract.owner_id,after:row.owner_id,reason:b.reason});
      }
    }
    if(b.collaborator_pm!==undefined) {assert(actor.role==='admin','协作人仅管理者可调整',403);const pm=Number(b.collaborator_pm)||null;assert(!pm||one(db,"SELECT id FROM users WHERE id=? AND role='pm' AND active=1 AND business_member=1 AND developer_admin=0",pm),'协作PM无效');row.collaborator_pm=pm;}
    if (b.amount !== undefined) {
      assert(o.stage !== "赢单", "已赢单金额请在合同台账处理");
      row.amount = cents(b.amount, "合同总额", true);
    }
    if(b.product_amount!==undefined)row.product_amount=cents(b.product_amount,'cash金额',true);
    const productAmount=row.product_amount===undefined?o.product_amount:row.product_amount;
    assert(productAmount===null||productAmount<=(row.amount??o.amount),'cash金额不能超过合同总额');
    if(b.sale_type!==undefined)row.sale_type=choice(b.sale_type,SALE_TYPES,'销售分类');
    if(b.order_type!==undefined)row.order_type=choice(b.order_type,ORDER_TYPES,'订单类型');
    for (const k of ["name", "next_action"])
      if (b[k] !== undefined)
        row[k] = text(b[k], k === "name" ? "商机名称" : "下一步动作", 500,k==='name');
    for (const k of ["follow_date", "expected_date"])
      if (b[k] !== undefined) row[k] = validDate(b[k], "日期", true);
    update("opportunities", o.id, row);
    audit(actor, "更新商机", "opportunity", o.id, {
      fields: Object.keys(row),
      reason: b.reason || "",
      ...(row.lost_reason !== undefined ? { lost_reason: { before: o.lost_reason || "", after: row.lost_reason } } : {}),
    });
    return { id: o.id, message: "商机已更新" };
  }
}
