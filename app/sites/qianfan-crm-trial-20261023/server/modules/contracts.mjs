import {
  assert,
  text,
  choice,
  cents,
  validDate,
  now,
  today,
  code,
} from "../domain.mjs";
import { one } from "../database.mjs";

/** contracts: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleContracts(context) {
  const { path, method, b, actor, db, insert, update, scoped, admin, audit } =
    context;
  let m;
  if (path === "/api/contracts" && method === "POST") {
    admin(actor);
    const o = b.opportunity_id
      ? scoped("opportunities", b.opportunity_id, actor)
      : null;
    const c = o
      ? scoped("customers", o.customer_id, actor)
      : scoped("customers", b.customer_id, actor);
    assert(
      !o || !["成交", "流失"].includes(o.stage),
      "该商机已结束，不能重复转合同",
      409,
    );
    assert(
      !o || !one(db, "SELECT id FROM contracts WHERE opportunity_id=?", o.id),
      "该商机已有关联合同",
      409,
    );
    assert(
      Array.isArray(b.items) && b.items.length > 0 && b.items.length <= 30,
      "请添加1至30个合同行项",
    );
    const items = b.items.map((i) => {
      const amount = cents(i.amount, "行项金额");
      const kind = choice(i.kind, ["标品", "实施"], "行项类型");
      const rate =
        kind === "实施"
          ? 0.5
          : o?.nature === "续签"
            ? 0.25
            : o?.source === "分发"
              ? 0.35
              : 0.45;
      return {
        name: text(i.name, "行项名称", 160),
        kind,
        amount,
        rate,
        margin: Math.round(amount * rate),
        payment_date: validDate(i.payment_date, "付款日", true),
        valid_until: validDate(i.valid_until, "到期日", true),
      };
    });
    const amount = items.reduce((s, i) => s + i.amount, 0);
    const id = insert("contracts", {
      opportunity_id: o?.id || null,
      customer_id: c.id,
      owner_id: o?.owner_id || c.owner_id,
      name: text(b.name || o?.name, "合同名称", 160),
      amount,
      sign_date: validDate(b.sign_date || today(), "签约日期"),
      valid_until: validDate(b.valid_until, "到期日", true),
      scope: text(b.scope || "", "交付范围", 3000, false),
      accept_status: "待交付",
      created_at: now(),
    });
    items.forEach((i) => insert("contract_items", { contract_id: id, ...i }));
    if (o) {
      update("opportunities", o.id, {
        stage: "成交",
        amount,
        next_action: "跟进合同履约、验收与回款节点",
        follow_date: null,
        stage_at: now(),
        updated_at: now(),
      });
      insert("activities", {
        opportunity_id: o.id,
        user_id: actor.id,
        source: "系统里程碑",
        activity_type: "系统",
        summary: `成交并生成合同 ${code("HT", id, now())}`,
        action: "明确交付与回款节点",
        activity_date: today(),
        created_at: now(),
      });
    }
    update("customers", c.id, { status: "成交", updated_at: now() });
    audit(actor, "创建合同", "contract", id, {
      opportunity_id: o?.id,
      amount,
    });
    return { id, message: "合同已创建，商机与客户状态已同步" };
  }
  if ((m = path.match(/^\/api\/contracts\/(\d+)$/)) && method === "PATCH") {
    admin(actor);
    const c = scoped("contracts", m[1], actor);
    const row = {};
    if (b.accept_status !== undefined)
      row.accept_status = choice(
        b.accept_status,
        ["待交付", "交付中", "待验收", "已验收"],
        "验收状态",
      );
    if (b.scope !== undefined)
      row.scope = text(b.scope, "交付范围", 3000, false);
    if (b.valid_until !== undefined)
      row.valid_until = validDate(b.valid_until, "到期日", true);
    assert(Object.keys(row).length, "没有可更新内容");
    update("contracts", c.id, row);
    audit(actor, "更新合同", "contract", c.id, row);
    return { id: c.id, message: "合同已更新" };
  }
  if ((m = path.match(/^\/api\/items\/(\d+)$/)) && method === "PATCH") {
    admin(actor);
    const i = one(db, "SELECT * FROM contract_items WHERE id=?", Number(m[1]));
    assert(i, "行项不存在", 404);
    const row = {};
    for (const k of ["payment_date", "valid_until"])
      if (b[k] !== undefined) row[k] = validDate(b[k], "行项日期", true);
    if (b.margin !== undefined) {
      text(b.reason, "毛利改判原因", 1000);
      row.margin = cents(b.margin, "毛利", true);
    }
    assert(Object.keys(row).length, "没有可更新内容");
    update("contract_items", i.id, row);
    audit(actor, "更新合同行项", "contract", i.contract_id, {
      item_id: i.id,
      ...row,
      reason: b.reason || "",
    });
    return { id: i.id, message: "合同行项已更新" };
  }
}
