import {businessDate, financeAmount, managementReport} from './management-finance.js';
import {workbenchForecast} from './workbench-view-model.js';
import {analyticsTargetPipeline} from './analytics-target-pipeline.js';

const day = 86400000;
const riskLevels = ['critical', 'warning', 'attention', 'normal'];
const riskRank = level => {
  const index = riskLevels.indexOf(level);
  return index < 0 ? riskLevels.length - 1 : index;
};
const dateValue = date => Date.parse(date + 'T00:00:00Z');
const shiftDate = (date, days) => new Date(dateValue(date) + days * day).toISOString().slice(0, 10);
const dueOrder = date => date || '9999-12-31';
const moneyKnown = amount => Number.isSafeInteger(amount) && amount >= 0;

function opportunityRow(opportunity, today) {
  const date = businessDate(opportunity.expected_date);
  const followDate = businessDate(opportunity.follow_date);
  const nextAction = String(opportunity.next_action ?? '').trim();
  const amount = workbenchForecast(opportunity);
  const reasons = new Set();
  const levels = [opportunity.risk?.level];
  for (const diagnostic of opportunity.diagnostics || []) {
    if (diagnostic?.message) reasons.add(diagnostic.message);
    if (diagnostic?.level) levels.push(diagnostic.level);
  }
  for (const item of opportunity.risk_reasons || []) {
    const message = typeof item === 'string' ? item : item?.message;
    if (message) reasons.add(message);
  }
  if (riskRank(opportunity.risk?.level) < riskRank('normal') && opportunity.risk?.label) {
    reasons.add(opportunity.risk.label);
  }
  if (date && date < today) {
    reasons.add('预计签约日已延期');
    levels.push('warning');
  }
  if (followDate && followDate < today) {
    if (![...reasons].some(reason => reason.includes('跟进') && reason.includes('逾期'))) reasons.add('跟进已逾期');
    levels.push('warning');
  }
  if (!nextAction) reasons.add('下一步未安排');
  if (!followDate) reasons.add('下次跟进日期未安排');
  if (!date) reasons.add('预计签约日待补充');
  if (amount === null) reasons.add('预计金额待补充');
  if (levels.some(level => riskRank(level) < riskRank('normal')) && !reasons.size) reasons.add('商机风险待核对');
  if (reasons.size) levels.push('attention');
  const level = levels.reduce((highest, candidate) =>
    riskRank(candidate) < riskRank(highest) ? candidate : highest, 'normal');
  return {opportunity, date, amount, reasons: [...reasons], nextAction, level};
}

function opportunityPriority(a, b) {
  return riskRank(a.level) - riskRank(b.level) ||
    dueOrder(a.date).localeCompare(dueOrder(b.date)) ||
    (b.amount ?? -1) - (a.amount ?? -1);
}

function interventionRows(rows, today, month) {
  const inMonth = row => row.date.startsWith(month + '-');
  return rows.filter(row => row.reasons.length && (
    inMonth(row) || row.date && row.date < today ||
    row.opportunity.stage === '商务' && (!row.date || !row.nextAction)
  )).sort((a, b) => Number(inMonth(b)) - Number(inMonth(a)) || opportunityPriority(a, b));
}

function cashRisk(report, today) {
  const upcomingThrough = shiftDate(today, 6);
  const plansByContract = new Map();
  for (const row of report.plans) {
    const id = String(row.contract.id);
    if (!plansByContract.has(id)) plansByContract.set(id, []);
    plansByContract.get(id).push(row);
  }
  const balances = new Map(report.outstanding.map(contract => {
    const plans = plansByContract.get(String(contract.id)) || [];
    const planned = financeAmount(plans, row => row.amount);
    const known = moneyKnown(contract.outstanding) && !planned.missing;
    const mismatch = contract.needs_plan_review || known && planned.total > contract.outstanding;
    return [String(contract.id), {
      mismatch,
      unplanned: known ? Math.max(0, contract.outstanding - planned.total) : null,
    }];
  }));
  const planRisk = (row, kind, reason) => {
    const needsReview = Boolean(balances.get(String(row.contract.id))?.mismatch);
    return { ...row, kind, needsReview, reason: needsReview ? reason + '，计划与未收余额待核对' : reason };
  };
  const byDueDate = (a, b) => a.date.localeCompare(b.date) || (b.amount ?? -1) - (a.amount ?? -1);
  const overdue = report.overdue.map(row => planRisk(row, 'overdue',
    `已逾期 ${Math.round((dateValue(today) - dateValue(row.date)) / day)} 天`)).sort(byDueDate);
  const upcoming = report.plans.filter(row => row.date >= today && row.date <= upcomingThrough)
    .map(row => planRisk(row, 'upcoming', row.date === today ? '今日到期' : '未来 7 天内到期')).sort(byDueDate);
  const undated = report.plans.filter(row => !row.date)
    .map(row => planRisk(row, 'undated', '收款计划待补预计收款日'));
  const unplanned = report.outstanding.flatMap(contract => {
    const amount = balances.get(String(contract.id)).unplanned;
    if (amount === 0) return [];
    return [{contract, plan: null, kind: 'unplanned', date: '', amount,
      reason: amount === null ? '合同未收余额或计划金额待核对' : '部分或全部余额待安排收款计划'}];
  }).sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1));
  return {overdue, upcoming, unplanned, priority: [...overdue, ...upcoming, ...undated, ...unplanned], upcomingThrough};
}

export function analyticsManagementModel(S, P = {}) {
  const report = managementReport(S, P);
  const today = S.today;
  const month = today.slice(0, 7);
  const rows = report.active.map(opportunity => opportunityRow(opportunity, today));
  const pipeline = analyticsTargetPipeline(S, P, rows);
  return {report, pipeline, interventions:interventionRows(pipeline.rows, today, month), cash:cashRisk(report, today)};
}
