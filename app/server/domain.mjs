import {processLedger} from './performance-ledger.mjs';
export {normalize, similarCustomer} from '../public/modules/customer-identity.js';
export const SALE_TYPES = ['新签自建','新签分发','续费','增购'];
export const ORDER_TYPES = ['代销','经销','千帆'];
export const STAGES = [
  "线索",
  "需求",
  "方案",
  "商务",
  "赢单",
  "输单",
  "搁置",
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
export function manDays(value = 0) {
  assert((typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '', '人天数须为非负数字');
  const n = Number(value);
  assert(Number.isFinite(n) && n >= 0 && n <= 1000000 && Math.abs(n * 100 - Math.round(n * 100)) < 0.001, '人天数须为0至1000000之间、最多两位小数的数字');
  return Math.round(n * 100) / 100;
}
export const code = (prefix, id, created) =>
  `${prefix}${created.slice(0, 7).replace("-", "")}${String(id).padStart(4, "0")}`;
export function risk(opp, rules) {
  if (["赢单", "输单", "搁置"].includes(opp.stage))
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
      days >= threshold * 2
        ? "critical"
        : days > threshold || overdue > 0
          ? "warning"
          : "normal",
    label:
      days >= threshold * 2
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
  policy = {cap:50,meeting:0.5,visit:1,quote:0.5,process_weight:70},
) {
  return processLedger(opps,activities,quotes,userId,month,policy).process;
}
