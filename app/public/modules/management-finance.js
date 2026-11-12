import { isClosedStage } from '../ui.js';
import { isOpenPlan, planRemaining } from './collection-forms.js';

const shanghaiDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});
const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/;
const day = 86400000;

export function businessDate(value) {
  if (!value) return '';
  if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return String(value).slice(0, 10);
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : shanghaiDate.format(date);
}

const dayValue = date => Date.parse(date + 'T00:00:00Z');
const dateAt = value => new Date(value).toISOString().slice(0, 10);

export function monthRange(month, today) {
  const selected = validMonth.test(month || '') ? month : today.slice(0, 7);
  const start = selected + '-01';
  const end = new Date(start + 'T00:00:00Z');
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { from: start, to: dateAt(end.getTime() - day) };
}

export function managementMonth(S, P = {}) {
  const current = S.today.slice(0, 7);
  return validMonth.test(P.managementMonth || '') && P.managementMonth <= current ? P.managementMonth : current;
}

export function managementRange(S, P = {}) {
  if (P.managementPreset === 'custom' || P.from || P.to) return { from: P.from || '', to: P.to || '' };
  if (P.managementMonth) return monthRange(managementMonth(S, P), S.today);
  const current = monthRange(S.today.slice(0, 7), S.today);
  if (P.managementPreset === 'last-month') {
    return monthRange(dateAt(dayValue(current.from) - day).slice(0, 7), S.today);
  }
  if (P.managementPreset === 'this-quarter') {
    const month = Number(S.today.slice(5, 7));
    const date = offset => `${S.today.slice(0, 4)}-${String(Math.floor((month - 1) / 3) * 3 + offset).padStart(2, '0')}`;
    return { from: date(1) + '-01', to: monthRange(date(3), S.today).to };
  }
  return current;
}

export function financeAmount(rows, get) {
  const values = rows.map(get).filter(value => typeof value === 'number' && Number.isFinite(value));
  return { total: values.reduce((sum, value) => sum + value, 0), missing: rows.length - values.length };
}

export function memberMonthlyTarget(S, owner, month) {
  const quarter = `${month.slice(0, 4)}Q${Math.ceil(Number(month.slice(5, 7)) / 3)}`;
  const target = (S.targets || []).find(t => Number(t.user_id) === Number(owner) && t.quarter === quarter);
  if (target?.amount > 0) return Math.round(target.amount / 3);
  const performance = (S.performance || []).find(p => Number(p.user_id) === Number(owner) && p.month === month);
  return performance?.monthly_target > 0 ? performance.monthly_target : null;
}

export function managementReport(S, P = {}) {
  const today = S.today;
  const range = managementRange(S, P);
  const invalid = Boolean(range.from && range.to && range.from > range.to);
  const owner = S.actor.role === 'sales' ? String(S.actor.id)
    : S.actor.role === 'admin' && /^\d+$/.test(String(P.owner || '')) ? String(P.owner) : '';
  const inRange = date => !!date && !invalid && (!range.from || date >= range.from) && (!range.to || date <= range.to);
  const customers = new Map((S.customers || []).map(customer => [Number(customer.id), customer]));
  const opportunities = new Map((S.opportunities || []).map(o => [Number(o.id), o]));
  const matches = (row, saleType) => (!owner || Number(row.owner_id) === Number(owner)) &&
    (!P.level || customers.get(Number(row.customer_id))?.manual_level === P.level) &&
    (!P.saleType || saleType === P.saleType);
  const active = [...opportunities.values()].filter(o => !o.archived_at && !isClosedStage(o.stage) && matches(o, o.sale_type));
  const expected = active.filter(o => inRange(businessDate(o.expected_date)))
    .sort((a, b) => a.expected_date.localeCompare(b.expected_date));
  const contracts = (S.contracts || []).filter(c => !c.retired_at && c.lifecycle !== '草稿' &&
    matches(c, c.sale_type || opportunities.get(Number(c.opportunity_id))?.sale_type));
  const signed = contracts.filter(c => {
    const date = businessDate(c.sign_date);
    return inRange(date) && date <= today;
  }).sort((a, b) => b.sign_date.localeCompare(a.sign_date));
  const receipts = contracts.flatMap(contract => (contract.payments || []).flatMap(payment => {
    const date = businessDate(payment.pay_date);
    return payment.status === '已到账' && payment.record_type !== 'plan' && !payment.voided_at && inRange(date) && date <= today
      ? [{ contract, payment }] : [];
  })).sort((a, b) => b.payment.pay_date.localeCompare(a.payment.pay_date));
  const outstanding = contracts.filter(c => c.outstanding == null || c.outstanding > 0);
  const plans = outstanding.flatMap(contract => (contract.payments || []).filter(p => p.record_type !== 'receipt' && isOpenPlan(p))
    .map(plan => ({ contract, plan, date: businessDate(plan.promise_date), amount: planRemaining(plan) })))
    .sort((a, b) => (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31'));
  const overdue = plans.filter(row => row.date && row.date < today);
  return { range, owner, active, expected, signed, receipts, outstanding, overdue, plans, invalid };
}
