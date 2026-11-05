import { assert, text, choice, normalize, now } from "../domain.mjs";
import { one, run } from "../database.mjs";

/** customers: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleCustomers(context) {
  const {
    path,
    method,
    b,
    actor,
    db,
    insert,
    update,
    scoped,
    admin,
    owner,
    audit,
  } = context;
  let m;
  if (path === "/api/customers" && method === "POST") {
    const name = text(b.name, "客户全称", 120);
    const norm = normalize(name);
    assert(
      !one(db, "SELECT id FROM customers WHERE normalized=?", norm),
      "已有同名客户，请先查看客户档案",
      409,
    );
    const credit = text(b.credit_code || "", "统一社会信用代码", 40, false);
    assert(
      !credit ||
        !one(db, "SELECT id FROM customers WHERE credit_code=?", credit),
      "统一社会信用代码已存在",
      409,
    );
    const id = insert("customers", {
      name,
      normalized: norm,
      short_name: text(b.short_name || "", "简称", 30, false),
      industry: text(b.industry || "", "行业", 40, false),
      region: text(b.region || "", "地区", 40, false),
      level: choice(b.level || "B", ["A", "B", "C"], "客户等级"),
      owner_id: owner(b.owner_id, actor),
      status: "潜在",
      credit_code: credit,
      scale: text(b.scale || "", "规模", 40, false),
      note: text(b.note || "", "备注", 2000, false),
      created_at: now(),
      updated_at: now(),
    });
    audit(actor, "创建客户", "customer", id, { name });
    return { id, message: "客户已创建" };
  }
  if ((m = path.match(/^\/api\/customers\/(\d+)$/)) && method === "PATCH") {
    const c = scoped("customers", m[1], actor);
    const row = { updated_at: now() };
    for (const k of [
      "name",
      "short_name",
      "industry",
      "region",
      "scale",
      "credit_code",
      "note",
    ])
      if (b[k] !== undefined)
        row[k] = text(
          b[k],
          k === "name" ? "客户全称" : "字段",
          k === "note" ? 2000 : 120,
          k === "name",
        );
    if (row.name) {
      row.normalized = normalize(row.name);
      assert(
        !one(
          db,
          "SELECT id FROM customers WHERE normalized=? AND id!=?",
          row.normalized,
          c.id,
        ),
        "已有同名客户",
        409,
      );
    }
    if (row.credit_code)
      assert(
        !one(
          db,
          "SELECT id FROM customers WHERE credit_code=? AND id!=?",
          row.credit_code,
          c.id,
        ),
        "统一社会信用代码已存在",
        409,
      );
    if (b.level !== undefined)
      row.level = choice(b.level, ["A", "B", "C"], "等级");
    if (b.status !== undefined)
      row.status = choice(b.status, ["潜在", "成交", "流失", "冻结"], "状态");
    if (b.owner_id !== undefined && Number(b.owner_id) !== c.owner_id) {
      admin(actor);
      text(b.reason, "归属调整原因", 500);
      row.owner_id = owner(b.owner_id, actor);
      run(
        db,
        "UPDATE opportunities SET owner_id=?,updated_at=? WHERE customer_id=?",
        row.owner_id,
        now(),
        c.id,
      );
      run(
        db,
        "UPDATE contracts SET owner_id=? WHERE customer_id=?",
        row.owner_id,
        c.id,
      );
    }
    update("customers", c.id, row);
    audit(actor, "更新客户", "customer", c.id, {
      fields: Object.keys(row),
      reason: b.reason || "",
    });
    return { id: c.id, message: "客户档案已更新" };
  }
  if (path === "/api/contacts" && method === "POST") {
    const c = scoped("customers", b.customer_id, actor);
    const id = insert("contacts", {
      customer_id: c.id,
      name: text(b.name, "联系人", 40),
      title: text(b.title || "", "职位", 80, false),
      phone: text(b.phone || "", "电话", 40, false),
      role: choice(
        b.role || "使用人",
        ["决策人", "影响者", "使用人", "把关人"],
        "角色",
      ),
      attitude: choice(b.attitude || "中立", ["支持", "中立", "反对"], "态度"),
      note: text(b.note || "", "备注", 1000, false),
    });
    audit(actor, "添加联系人", "customer", c.id, { name: b.name });
    return { id, message: "联系人已添加" };
  }
}
