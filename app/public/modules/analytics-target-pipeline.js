import {isClosedStage} from '../ui.js';
import {businessDate, financeAmount, managementReport, monthRange} from './management-finance.js';
import {quarterOf} from './targets.js';

const amountOf = row => row.amount;
const ownerId = row => String(row.owner_id ?? '');
const knownMoney = value => Number.isSafeInteger(value) && value >= 0;
const days = 86400000;
const asUtc = date => Date.parse(date + 'T00:00:00Z');
const salesMember = member => member.role === 'sales' &&
  member.active !== 0 && member.active !== false &&
  member.business_member !== 0 && member.business_member !== false && !member.developer_admin;

function validDate(value) {
  const date = businessDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const time = asUtc(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? date : '';
}

function targetMembers(S, owner, quarter) {
  const roster = new Map([...(S.team || []), ...(S.users || [])].map(member => [String(member.id), member]));
  const targets = new Map((S.targets || []).filter(row => row.quarter === quarter && knownMoney(row.amount) && row.amount > 0)
    .map(row => [String(row.user_id), row.amount]));
  return [...roster.values()]
    .filter(member => salesMember(member) && (!owner || String(member.id) === owner))
    .map(member => {
      const quarterAmount = targets.get(String(member.id)) ?? null;
      const monthlyAmount = quarterAmount === null ? null : Math.round(quarterAmount / 3);
      return {member, amount: monthlyAmount, monthlyAmount, quarterAmount};
    });
}

function forecastRow(row) {
  const {opportunity} = row;
  const date = validDate(row.date);
  const followDate = validDate(opportunity.follow_date);
  const originalAmount = knownMoney(row.amount) ? row.amount : null;
  const summary = opportunity.signed_summary;
  const hasLinkedSigned = Number(summary?.count) > 0;
  const signedAmount = hasLinkedSigned ? (knownMoney(summary.amount) ? summary.amount : null) : 0;
  const amount = originalAmount === null || signedAmount === null ? null : Math.max(0, originalAmount - signedAmount);
  const fullyCovered = signedAmount > 0 && amount === 0;
  const reasons = new Set(row.reasons || []);
  if (!date) reasons.add('预计签约日待补充');
  if (originalAmount === null) reasons.add('预计金额待补充');
  if (signedAmount === null) reasons.add('关联合同已签金额待核对');
  if (fullyCovered) reasons.add('已签金额覆盖预估，请核对商机阶段');
  return {...row, date, followDate, amount, originalAmount, signedAmount, fullyCovered, reasons: [...reasons],
    level: reasons.size && (!row.level || row.level === 'normal') ? 'attention' : row.level || 'normal'};
}

const byForecast = (a, b) => a.date.localeCompare(b.date) || (b.amount ?? -1) - (a.amount ?? -1);
const stageOf = row => row.opportunity.stage || '阶段待补';
const isCommercial = row => stageOf(row) === '商务';
const monthOf = date => date.slice(0, 7);

function commercialBreakdown(expected) {
  const all = expected.filter(isCommercial);
  return {all, ready: all.filter(row => !row.reasons.length), atRisk: all.filter(row => row.reasons.length)};
}

const gapAfter = (gap, forecast) => gap === null ? null
  : gap === 0 ? 0 : forecast.missing ? null : Math.max(0, gap - forecast.total);

function periodMetrics(key, range, target, signedRows, allSignedRows, expected, coveredOwners) {
  const signed = financeAmount(signedRows, amountOf);
  const allSigned = financeAmount(allSignedRows, amountOf);
  const gap = target === null || signed.missing ? null : Math.max(0, target - signed.total);
  const commercial = commercialBreakdown(expected);
  const covered = target === null ? [] : expected.filter(row => coveredOwners.has(ownerId(row.opportunity)));
  const {ready, all} = commercialBreakdown(covered);
  const readyAmount = financeAmount(ready, amountOf);
  const allAmount = financeAmount(all, amountOf);
  const expectedAmount = financeAmount(covered, amountOf);
  const coverage = {ready, all, expected: covered, readyAmount, allAmount, expectedAmount,
    afterReady: gapAfter(gap, readyAmount), afterAll: gapAfter(gap, allAmount), afterExpected: gapAfter(gap, expectedAmount)};
  return {key, range, target, signed, signedRows, allSigned, allSignedRows, gap, expected, commercial, coverage,
    expectedAmount: financeAmount(expected, amountOf)};
}

function stageAge(row, today) {
  const entered = validDate(row.opportunity.stage_at);
  if (entered && entered <= today) return Math.round((asUtc(today) - asUtc(entered)) / days);
  const age = row.opportunity.risk?.days;
  return Number.isFinite(age) && age >= 0 ? age : null;
}

function stageInventory(S, rows, month, quarterEnd) {
  const stages = new Map((S.stages || []).filter(stage => !isClosedStage(stage)).map(stage => [stage, []]));
  for (const row of rows) {
    const stage = stageOf(row);
    if (!stages.has(stage)) stages.set(stage, []);
    stages.get(stage).push(row);
  }
  return [...stages].map(([stage, active]) => {
    const stageThreshold = S.rules?.thresholds?.[stage];
    const byAge = active.map(row => {
      const threshold = row.opportunity.risk?.threshold || stageThreshold || 5;
      return {row, age: stageAge(row, S.today), threshold};
    });
    const aged = byAge.filter(item => item.age !== null);
    const stalled = aged.filter(item => item.age > item.threshold).map(item => item.row);
    const stalledRows = new Set(stalled);
    const overdue = active.filter(row => stalledRows.has(row) || row.date && row.date < S.today ||
      row.followDate && row.followDate < S.today);
    return {stage, active, overdue, stalled,
      amount: financeAmount(active, amountOf),
      averageAge: aged.length ? Math.round(aged.reduce((sum, item) => sum + item.age, 0) / aged.length) : null,
      ageCount: aged.length,
      created: active.filter(row => {
        const date = validDate(row.opportunity.created_at);
        return monthOf(date) === month && date <= S.today;
      }),
      monthly: active.filter(row => !row.fullyCovered && monthOf(row.date) === month),
      later: active.filter(row => !row.fullyCovered && monthOf(row.date) > month && row.date <= quarterEnd),
      undated: active.filter(row => !row.date)};
  });
}

export function analyticsTargetPipeline(S, P, opportunityRows) {
  const today = S.today, month = monthOf(today), quarter = quarterOf(month);
  const scope = {owner: P.owner, level: P.level, saleType: P.saleType, managementPreset: 'this-quarter'};
  const report = managementReport(S, scope);
  const {owner} = report;
  const comparable = !P.level && !P.saleType;
  const members = targetMembers(S, owner, quarter);
  const configured = members.filter(row => row.quarterAmount !== null);
  const coveredOwners = new Set(configured.map(row => String(row.member.id)));
  const target = field => comparable && configured.length
    ? configured.reduce((sum, row) => sum + row[field], 0) : null;
  const inTarget = contract => comparable && coveredOwners.has(ownerId(contract));
  const activeIds = new Set(report.active.map(opportunity => String(opportunity.id)));
  const byId = new Map(opportunityRows.map(row => [String(row.opportunity.id), row]));
  const rows = [...byId].filter(([id]) => activeIds.has(id)).map(([, row]) => forecastRow(row));
  const quarterEnd = report.range.to;
  const expected = rows.filter(row => !row.fullyCovered && monthOf(row.date) >= month && row.date <= quarterEnd).sort(byForecast);
  const monthExpected = expected.filter(row => monthOf(row.date) === month);
  const monthSigned = report.signed.filter(contract => monthOf(validDate(contract.sign_date)) === month);
  const monthly = periodMetrics(month, monthRange(month, today), target('monthlyAmount'),
    monthSigned.filter(inTarget), monthSigned, monthExpected, coveredOwners);
  const quarterly = periodMetrics(quarter, report.range, target('quarterAmount'),
    report.signed.filter(inTarget), report.signed, expected, coveredOwners);
  const firstMonth = monthOf(report.range.from);
  const quarterMonths = [0, 1, 2].map(offset => {
    const key = firstMonth.slice(0, 5) + String(Number(firstMonth.slice(5)) + offset).padStart(2, '0');
    const signedRows = report.signed.filter(contract => monthOf(validDate(contract.sign_date)) === key);
    const forecast = expected.filter(row => monthOf(row.date) === key);
    return {month: key, isFuture: key > month, signedRows, signed: financeAmount(signedRows, amountOf),
      coveredSigned: financeAmount(signedRows.filter(inTarget), amountOf), expected: forecast,
      expectedAmount: financeAmount(forecast, amountOf), commercial: commercialBreakdown(forecast)};
  });
  const stages = stageInventory(S, rows, month, quarterEnd);
  return {month, quarter, today, owner, comparable, members, configured: configured.length, missing: members.length - configured.length,
    rows, monthly, quarterly, quarterMonths, stages, monthCreated: stages.flatMap(stage => stage.created),
    laterExpected: expected.filter(row => monthOf(row.date) > month),
    undatedCommercial: rows.filter(row => isCommercial(row) && !row.date),
    overdueCommercial: rows.filter(row => isCommercial(row) && row.date && row.date < today).sort(byForecast)};
}
