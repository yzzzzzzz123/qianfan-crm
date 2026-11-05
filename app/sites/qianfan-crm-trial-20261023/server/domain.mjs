import { Buffer } from "buffer";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
export const STAGES = [
  "线索",
  "初步接触",
  "需求确认",
  "方案沟通",
  "报价",
  "POC 试用",
  "商务谈判",
  "成交",
  "流失",
];
export const now = () => new Date().toISOString();
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const dateAdd = (days, base = today()) =>
  new Date(new Date(base + "T12:00:00+08:00").getTime() + days * 86400000)
    .toISOString()
    .slice(0, 10);
export const period = () => today().slice(0, 7);
export const quarter = () =>
  `${today().slice(0, 4)}Q${Math.ceil(Number(today().slice(5, 7)) / 3)}`;
export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
export function assert(ok, message, status = 400) {
  if (!ok) throw new AppError(message, status);
}
export function text(v, name, max = 500, required = true) {
  assert(typeof v === "string", `请填写${name}`);
  const s = v.trim();
  assert(!required || s.length > 0, `请填写${name}`);
  assert(s.length <= max, `${name}不能超过${max}字`);
  return s;
}
export function choice(v, values, name) {
  assert(values.includes(v), `${name}不在允许范围内`);
  return v;
}
export function cents(v, name = "金额", allowZero = false) {
  assert(
    (typeof v === "number" || typeof v === "string") && String(v).trim() !== "",
    `请填写${name}`,
  );
  const n = Number(v);
  assert(
    Number.isFinite(n) && n >= 0 && (allowZero || n > 0) && n <= 1e10,
    `${name}须为${allowZero ? "非负" : "大于零的"}有效金额`,
  );
  assert(
    Math.abs(n * 100 - Math.round(n * 100)) < 0.001,
    `${name}最多保留两位小数`,
  );
  return Math.round(n * 100);
}
export function validDate(v, name = "日期", optional = false) {
  if (optional && (v === null || v === undefined || v === "")) return null;
  assert(
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v),
    `请选择${name}`,
  );
  const d = new Date(v + "T12:00:00Z");
  assert(!isNaN(d) && d.toISOString().slice(0, 10) === v, `${name}无效`);
  return v;
}
export const normalize = (s) => s.replace(/[\s（）()]/g, "").toLowerCase();
export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function verifyPassword(password, hash) {
  try {
    const [salt, h] = hash.split(":");
    const computed = scryptSync(password, salt, 64);
    const stored = Buffer.from(h, "hex");
    return (
      stored.length === computed.length && timingSafeEqual(stored, computed)
    );
  } catch {
    return false;
  }
}
export const code = (prefix, id, created) =>
  `${prefix}${created.slice(0, 7).replace("-", "")}${String(id).padStart(4, "0")}`;
export function risk(opp, rules) {
  if (["成交", "流失"].includes(opp.stage))
    return { level: "normal", label: "已结束", days: 0, overdue: 0 };
  const days = Math.max(
    0,
    Math.floor(
      (new Date(today()) - new Date(opp.stage_at.slice(0, 10))) / 86400000,
    ),
  );
  const threshold = rules.thresholds[opp.stage] || 5;
  const overdue = opp.follow_date
    ? Math.max(
        0,
        Math.floor((new Date(today()) - new Date(opp.follow_date)) / 86400000),
      )
    : 0;
  return {
    days,
    overdue,
    threshold,
    level:
      days > threshold * 2
        ? "critical"
        : days > threshold || overdue > 0
          ? "warning"
          : "normal",
    label:
      days > threshold * 2
        ? "严重停滞"
        : overdue > 0
          ? "跟进逾期"
          : days > threshold
            ? "阶段停滞"
            : "正常推进",
  };
}
export function processScore(
  opps,
  activities,
  quotes,
  userId,
  month = period(),
) {
  const own = opps.filter((o) => o.owner_id === userId);
  const refs = new Set(own.map((o) => o.id));
  const a = activities.filter(
    (a) => refs.has(a.opportunity_id) && a.activity_date.startsWith(month),
  );
  const newOpp = own.filter((o) => o.created_at.slice(0, 7) === month);
  const meeting = a.filter((a) => a.activity_type === "线上会议").length;
  const visit = a.filter((a) => a.activity_type === "现场拜访").length;
  const quote = quotes.filter(
    (q) => q.user_id === userId && q.created_at.startsWith(month),
  ).length;
  const funnel = newOpp.reduce(
    (s, o) => s + (o.amount < 980000 ? 0.5 : o.amount <= 5000000 ? 2 : 3),
    0,
  );
  const raw = Math.min(50, meeting * 0.5 + visit + quote * 0.5 + funnel);
  return {
    meeting,
    visit,
    quote,
    funnelCount: newOpp.length,
    raw,
    weighted: Math.round((raw / 50) * 70 * 10) / 10,
  };
}
