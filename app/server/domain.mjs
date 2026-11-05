import {performancePolicy} from '../public/modules/performance-policy.js';
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
export const normalize = (s) => s.replace(/[\s（）()]/g, "").toLowerCase();
export function similarCustomer(a,b) {
  const tidy=s=>normalize(s).replace(/有限责任公司|股份有限公司|有限公司/g,'');
  const x=Array.from(tidy(a)),y=Array.from(tidy(b));
  if(Math.min(x.length,y.length)<4)return false;
  let row=y.map((_,i)=>i+1);row.unshift(0);
  for(let i=0;i<x.length;i++){const next=[i+1];for(let j=0;j<y.length;j++)next[j+1]=Math.min(next[j]+1,row[j+1]+1,row[j]+(x[i]===y[j]?0:1));row=next;}
  return 1-row[y.length]/Math.max(x.length,y.length)>=0.82;
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
  policy=performancePolicy(policy);
  const own = opps.filter((o) => o.owner_id === userId);
  const refs = new Set(own.map((o) => o.id));
  const a = activities.filter(
    (a) => refs.has(a.opportunity_id) && (a.user_id === undefined || a.user_id === userId) && a.activity_date.startsWith(month),
  );
  const newOpp = own.filter((o) => o.created_at.slice(0, 7) === month);
  const meeting = a.filter((a) => a.activity_type === "线上会议").length;
  const visit = a.filter((a) => a.activity_type === "现场拜访").length;
  const quoteRecords = quotes.filter(
    (q) => q.user_id === userId && q.created_at.startsWith(month),
  );
  const quoteDays=new Set(quoteRecords.map(q=>`${q.opportunity_id}:${q.created_at.slice(0,10)}`));
  const quoteEvents=new Set(a.filter(a=>a.activity_type==='对客报价'&&!quoteDays.has(`${a.opportunity_id}:${a.activity_date}`)).map(a=>`${a.opportunity_id}:${a.activity_date}`));
  const quote = quoteRecords.length+quoteEvents.size;
  const funnel = newOpp.reduce(
    (s, o) => s + ((o.initial_amount ?? o.amount) < 980000 ? policy.funnel_low : (o.initial_amount ?? o.amount) <= 5000000 ? policy.funnel_mid : policy.funnel_high),
    0,
  );
  const raw = Math.round(Math.min(policy.cap, meeting * policy.meeting + visit * policy.visit + quote * policy.quote + funnel)*100)/100;
  return {
    meeting,
    visit,
    quote,
    funnelCount: newOpp.length,
    raw,
    weighted: Math.round((raw / policy.cap) * policy.process_weight * 100) / 100,
  };
}
