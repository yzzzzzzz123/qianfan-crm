import {isClosedStage} from '../ui.js';
import {isOpenPlan,planRemaining} from './collection-forms.js';

const buckets = {overdue:0,today:1,risk:2};
const severity = {critical:0,warning:1,attention:2,normal:3};
const rank = level => severity[level] ?? severity.normal;
const dateOnly = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0,10) : '';
const inMonth = (date,month) => dateOnly(date).startsWith(month+'-');
const activeContract = contract => !contract.retired_at && contract.lifecycle !== '草稿';
const knownAmount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function workbenchForecast(opportunity) {
  return knownAmount(Object.hasOwn(opportunity,'forecast_amount') ? opportunity.forecast_amount : opportunity.amount);
}

function opportunityTask(opportunity,today,month) {
  const date = dateOnly(opportunity.follow_date);
  const due = date && date <= today;
  const expected = inMonth(opportunity.expected_date,month);
  const missingStep = !String(opportunity.next_action ?? '').trim();
  const level = opportunity.risk?.level;
  const riskReasons = (opportunity.risk_reasons ?? []).map(item =>
    typeof item === 'string' ? item : item?.message).filter(Boolean);
  const diagnostic = (opportunity.diagnostics ?? []).filter(item => item?.message).reduce((primary,item) =>
    !primary || rank(item.level) < rank(primary.level) ? item : primary,null);
  const hasRisk = rank(level) < severity.normal || !!diagnostic || riskReasons.length > 0;
  if (!due && !hasRisk && !(expected && missingStep)) return null;

  const bucket = due ? (date < today ? 'overdue' : 'today') : 'risk';
  const reason = expected && missingStep ? '预计本月签约，下一步未安排' :
    diagnostic?.message || riskReasons[0] || (hasRisk && opportunity.risk?.label) ||
    (missingStep ? '下一步未安排' : bucket === 'overdue' ? '跟进已逾期' : bucket === 'today' ? '今天应跟进' : '商机风险待处理');
  return {kind:'opportunity',bucket,id:opportunity.id,opportunity,date,
    amount:workbenchForecast(opportunity),reason,level:level || diagnostic?.level || 'normal'};
}

function collectionTasks(contract,today) {
  // Fully paid contracts may still have old plans awaiting reconciliation.
  if (contract.outstanding != null && contract.outstanding <= 0) return [];
  return (contract.payments ?? []).filter(plan => {
    const date = dateOnly(plan.promise_date);
    return plan.record_type !== 'receipt' && isOpenPlan(plan) && date && date <= today;
  }).map(plan => {
    const date = dateOnly(plan.promise_date);
    const bucket = date < today ? 'overdue' : 'today';
    const reason = contract.terminated_at ? '合同已终止，原收款计划仍有余款' :
      bucket === 'overdue' ? '收款计划逾期' : '收款计划今天到期';
    return {kind:'collection',bucket,id:plan.id,contract,plan,date,
      amount:knownAmount(planRemaining(plan)),reason,level:plan.escalation || 'normal'};
  });
}

function compareTasks(a,b) {
  return buckets[a.bucket] - buckets[b.bucket] ||
    rank(a.level) - rank(b.level) ||
    (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31') ||
    (b.amount ?? -1) - (a.amount ?? -1) ||
    a.kind.localeCompare(b.kind) || Number(a.id) - Number(b.id);
}

export function workbenchModel(S,requestedOwner = '') {
  const today = dateOnly(S.today);
  const month = today.slice(0,7);
  const role = S.actor?.role;
  const opportunities = (S.opportunities ?? []).filter(o => !o.archived_at && !isClosedStage(o.stage));
  const contracts = (S.contracts ?? []).filter(activeContract);
  const assigned = new Set([...opportunities,...contracts].map(record => String(record.owner_id)));
  const owners = role === 'admin' ? (S.users ?? []).filter(user =>
    ['admin','sales'].includes(user.role) && (user.active !== false && user.active !== 0 || assigned.has(String(user.id)))) : [];
  const owner = owners.some(user => String(user.id) === String(requestedOwner)) ? String(requestedOwner) : '';
  const scope = role === 'sales' ? String(S.actor.id) : owner;
  const inScope = record => !scope || String(record.owner_id) === scope;
  const active = opportunities.filter(inScope);
  const visibleContracts = contracts.filter(inScope);
  const expected = active.filter(o => inMonth(o.expected_date,month))
    .sort((a,b) => a.expected_date.localeCompare(b.expected_date));
  const signed = visibleContracts.filter(c => inMonth(c.sign_date,month))
    .sort((a,b) => b.sign_date.localeCompare(a.sign_date));
  const receipts = visibleContracts.flatMap(contract =>
    (contract.payments ?? []).filter(payment => payment.status === '已到账' && !payment.voided_at &&
      payment.record_type !== 'plan' && inMonth(payment.pay_date,month)).map(payment => ({contract,payment})))
    .sort((a,b) => b.payment.pay_date.localeCompare(a.payment.pay_date));
  const plans = (S.collections ?? contracts).filter(contract => activeContract(contract) && inScope(contract))
    .flatMap(contract => collectionTasks(contract,today));
  const tasks = [...active.map(o => opportunityTask(o,today,month)).filter(Boolean),...plans].sort(compareTasks);
  return {month,owner,owners,active,expected,signed,receipts,tasks};
}
