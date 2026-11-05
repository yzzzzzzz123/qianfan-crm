import { all, one } from "../database.mjs";
import {
  code,
  risk,
  processScore,
  period,
  quarter,
  today,
  STAGES,
} from "../domain.mjs";
import { publicUser } from "./auth.mjs";

export function buildState(context, actor) {
  const { db, getRules, demo } = context;
  const rules = getRules();
  const users = all(db, "SELECT * FROM users").map(publicUser);
  const customers = all(db, "SELECT * FROM customers ORDER BY id DESC").map(
    (c) =>
      actor.role === "admin" || c.owner_id === actor.id
        ? c
        : {
            id: c.id,
            name: c.name,
            short_name: c.short_name,
            industry: c.industry,
            region: c.region,
            level: c.level,
            owner_id: c.owner_id,
            status: c.status,
            shared: true,
          },
  );
  const own = actor.role === "admin" ? "" : " WHERE owner_id=?";
  const args = actor.role === "admin" ? [] : [actor.id];
  const opportunities = all(
    db,
    `SELECT * FROM opportunities${own} ORDER BY updated_at DESC`,
    ...args,
  ).map((o) => ({
    ...o,
    code: code("SJ", o.id, o.created_at),
    risk: risk(o, rules),
  }));
  const oppIds = new Set(opportunities.map((o) => o.id));
  const customerIds = new Set(
    customers.filter((c) => !c.shared).map((c) => c.id),
  );
  const activities = all(
    db,
    "SELECT * FROM activities ORDER BY activity_date DESC,id DESC",
  ).filter((a) => oppIds.has(a.opportunity_id));
  const quotes = all(db, "SELECT * FROM quotes ORDER BY id DESC")
    .filter((q) => oppIds.has(q.opportunity_id))
    .map((q) => ({ ...q, code: code("BJ", q.id, q.created_at) }));
  const contracts = all(
    db,
    `SELECT * FROM contracts${own} ORDER BY id DESC`,
    ...args,
  ).map((c) => {
    const items = all(
      db,
      "SELECT * FROM contract_items WHERE contract_id=?",
      c.id,
    );
    const payments = all(
      db,
      "SELECT * FROM payments WHERE contract_id=? ORDER BY id DESC",
      c.id,
    ).map((p) => ({
      ...p,
      status:
        p.status !== "已到账" && p.promise_date && p.promise_date < today()
          ? "逾期"
          : p.status,
    }));
    const collected = payments
      .filter((p) => p.status === "已到账")
      .reduce((s, p) => s + p.amount, 0);
    return {
      ...c,
      code: code("HT", c.id, c.created_at),
      items,
      payments,
      collected,
      outstanding: c.amount - collected,
    };
  });
  const team = users
    .filter(
      (u) =>
        u.active &&
        u.role === "sales" &&
        (actor.role === "admin" || u.id === actor.id),
    )
    .map((u) => {
      const o = opportunities.filter((o) => o.owner_id === u.id);
      const target = one(
        db,
        "SELECT amount FROM targets WHERE user_id=? AND quarter=?",
        u.id,
        quarter(),
      );
      const c = contracts.filter((c) => c.owner_id === u.id);
      return {
        ...u,
        process: processScore(opportunities, activities, quotes, u.id),
        pipeline: o
          .filter((o) => !["成交", "流失"].includes(o.stage))
          .reduce((s, o) => s + o.amount, 0),
        activeCount: o.filter((o) => !["成交", "流失"].includes(o.stage))
          .length,
        riskCount: o.filter((o) => o.risk.level !== "normal").length,
        followCount: activities.filter(
          (a) =>
            a.user_id === u.id &&
            a.activity_date >=
              new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
        ).length,
        signed: c
          .filter((c) => c.sign_date.startsWith(period()))
          .reduce((s, c) => s + c.amount, 0),
        target: target?.amount || 0,
      };
    });
  return {
    actor: publicUser(actor),
    demo,
    today: today(),
    period: period(),
    quarter: quarter(),
    rules,
    stages: STAGES,
    users:
      actor.role === "admin"
        ? users
        : users.map((u) => ({
            id: u.id,
            name: u.name,
            role: u.role,
            active: u.active,
          })),
    customers,
    opportunities,
    activities,
    quotes,
    contracts,
    contacts: all(db, "SELECT * FROM contacts").filter((c) =>
      customerIds.has(c.customer_id),
    ),
    team,
    audit:
      actor.role === "admin"
        ? all(
            db,
            "SELECT a.*,u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 200",
          )
        : [],
    integrations: [
      {
        id: "dingtalk",
        name: "钉钉身份登录",
        status: "待创建应用",
        description: "提供企业内部应用后配置免登与账号映射。",
      },
      {
        id: "aitable",
        name: "AI 表格单向同步",
        status: "待接入",
        description: "CRM → AI 表格，旧会话任务不随新版迁移。",
      },
      {
        id: "minutes",
        name: "AI 听记与消息通知",
        status: "待接入",
        description: "应用权限与回调配置就绪后联调。",
      },
      {
        id: "templates",
        name: "报价与合同模板",
        status: "待提供模板",
        description: "当前支持报价记录与合同台账，正式文件生成待模板确认。",
      },
      {
        id: "llm",
        name: "大模型分析",
        status: "未接入",
        description: "当前建议来自阶段规则和管理员维护的 SOP。",
      },
    ],
  };
}
