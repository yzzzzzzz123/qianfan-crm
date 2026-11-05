import {
  assert,
  text,
  choice,
  cents,
  validDate,
  STAGES,
  now,
  today,
} from "../domain.mjs";

/** opportunities: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleOpportunities(context) {
  const { path, method, b, actor, insert, update, scoped, owner, audit } =
    context;
  let m;
  if (path === "/api/opportunities" && method === "POST") {
    const c = scoped("customers", b.customer_id, actor);
    const stage = choice(
      b.stage || "线索",
      STAGES.filter((s) => !["成交", "流失"].includes(s)),
      "阶段",
    );
    const owner_id = owner(b.owner_id || c.owner_id, actor);
    assert(
      owner_id === c.owner_id,
      "商机负责人须与客户归属一致，请先调整客户归属",
    );
    const id = insert("opportunities", {
      name: text(b.name, "商机名称", 160),
      customer_id: c.id,
      owner_id,
      stage,
      amount: cents(b.amount, "预计金额", true),
      product_type: choice(
        b.product_type || "标品",
        ["标品", "实施", "混合"],
        "产品类型",
      ),
      source: choice(b.source || "自建", ["自建", "分发"], "商机来源"),
      nature: choice(b.nature || "新签", ["新签", "续签"], "订单性质"),
      next_action: text(b.next_action, "下一步动作", 500),
      follow_date: validDate(b.follow_date, "下次跟进日期"),
      expected_date: validDate(b.expected_date, "预计成交日期", true),
      stage_at: now(),
      created_at: now(),
      updated_at: now(),
    });
    audit(actor, "创建商机", "opportunity", id, { name: b.name });
    return { id, message: "商机已创建" };
  }
  if ((m = path.match(/^\/api\/opportunities\/(\d+)$/)) && method === "PATCH") {
    const o = scoped("opportunities", m[1], actor);
    const row = { updated_at: now() };
    if (b.stage !== undefined) {
      const stage = choice(b.stage, STAGES, "阶段");
      assert(
        stage !== "成交" || o.stage === "成交",
        "请通过“成交转合同”完成成交",
      );
      if (stage !== o.stage) {
        assert(
          !["成交", "流失"].includes(o.stage),
          "已结束商机不能直接重新推进",
        );
        row.stage = stage;
        row.stage_at = now();
        if (stage === "流失")
          row.lost_reason = text(b.lost_reason, "流失原因", 1000);
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
    if (b.amount !== undefined) {
      assert(o.stage !== "成交", "已成交金额请在合同台账处理");
      row.amount = cents(b.amount, "预计金额", true);
    }
    for (const k of ["name", "next_action"])
      if (b[k] !== undefined)
        row[k] = text(b[k], k === "name" ? "商机名称" : "下一步动作", 500);
    for (const k of ["follow_date", "expected_date"])
      if (b[k] !== undefined) row[k] = validDate(b[k], "日期", true);
    update("opportunities", o.id, row);
    audit(actor, "更新商机", "opportunity", o.id, {
      fields: Object.keys(row),
    });
    return { id: o.id, message: "商机已更新" };
  }
}
