import {plainMoney, salesName} from '../ui.js';
import {financeAmount} from './management-finance.js';

const amountOf = row => row.amount;
const recordOf = row => row.opportunity || row.contract;

function amountEvidence(rows, unit) {
  const {total, missing} = financeAmount(rows, amountOf);
  if (!rows.length) return plainMoney(0);
  if (missing === rows.length) return `${missing} ${unit}金额待核对`;
  if (missing) return `已知 ${plainMoney(total)}，另有 ${missing} ${unit}金额待核对`;
  return `${plainMoney(total)}（${rows.length} ${unit}）`;
}

function uniqueOpportunities(rows) {
  return [...new Map(rows.map(row => [row.opportunity.id, row])).values()];
}

function decision(S, id, title, evidence, nextAction, records, due, members = []) {
  const owners = records.length
    ? records.map(row => salesName(S, recordOf(row)))
    : members.map(row => row.member.name);
  return {id, title, evidence, nextAction, records, due, owners: [...new Set(owners)], drawerId: `decision-${id}`};
}

function signedEvidence(target) {
  return target.signedRows.filter(contract => !Number.isFinite(contract.amount)).map(contract =>
    ({kind: 'signed', contract, amount: contract.amount, date: contract.sign_date, reason: '签约金额待核对'}));
}

function monthlyDecision(S, pipeline) {
  const {monthly, overdueCommercial, undatedCommercial} = pipeline;
  const members = pipeline.members.filter(row => row.quarterAmount != null);
  const {coverage, gap} = monthly;
  if (monthly.target > 0 && monthly.signed.missing) {
    const records = signedEvidence(monthly);
    return decision(S, 'month', '先核对本月签约实绩',
      `${records.length} 份本月合同金额待核对，当前已知签约 ${plainMoney(monthly.signed.total)}。`,
      '请合同负责人逐份核对合同签约金额，再确认本月目标缺口。', records, '今天核对', members);
  }
  if (!(gap > 0)) {
    const records = uniqueOpportunities([...monthly.commercial.atRisk, ...overdueCommercial, ...undatedCommercial]);
    if (records.length) {
      return decision(S, 'month', '逐单核实商务卡点',
        `商务卡点涉及 ${amountEvidence(records, '条')}。`,
        '逐单确认预计签约日、当前阻碍和下一步。日期已过的商机需要重新核实客户时间。',
        records, '本周确认');
    }
    if (pipeline.comparable && monthly.target == null && pipeline.members.length) {
      return decision(S, 'month', '补设季度签约目标',
        `当前范围有 ${pipeline.members.length} 位销售待设置季度目标。`,
        '请管理者确认季度目标并维护到团队管理，随后核对月度折算目标。', [], '本周确认', pipeline.members);
    }
    return null;
  }

  const gapText = `本月签约缺口 ${plainMoney(gap)}。`;
  const risk = coverage.all.filter(row => row.reasons.length);
  const proposals = coverage.expected.filter(row => row.opportunity.stage === '方案');
  if (coverage.afterExpected > 0) {
    const ownerIds = new Set(members.map(row => String(row.member.id)));
    const toReview = [...overdueCommercial, ...undatedCommercial].filter(row => ownerIds.has(String(row.opportunity.owner_id)));
    const records = uniqueOpportunities([...risk, ...proposals, ...coverage.expected, ...toReview]);
    const nextAction = proposals.length
      ? '先逐单核实商务卡点，再核对方案商机的采购和签约节点，确认哪些项目可加速。'
      : '逐单核实现有商机的签约安排，并明确还需补充的项目和负责人。';
    return decision(S, 'month', '补充本月可签商机',
      `${gapText}已设目标销售的本月预计签约 ${amountEvidence(coverage.expected, '条')}，即使全部签下仍差 ${plainMoney(coverage.afterExpected)}。`,
      nextAction, records, '本周确认', members);
  }

  const unknown = coverage.expected.filter(row => !Number.isFinite(row.amount));
  if (unknown.length && coverage.afterExpected == null && coverage.afterReady !== 0) {
    return decision(S, 'month', '补齐本月商机金额',
      `${gapText}本月预计签约 ${amountEvidence(coverage.expected, '条')}。`,
      '先补齐待核对商机的预计金额和下一步，再核算本月签约储备。',
      unknown, '今天核对', members);
  }

  if (coverage.afterAll > 0) {
    const records = uniqueOpportunities([...risk, ...proposals, ...coverage.all, ...coverage.expected]);
    const title = proposals.length ? '推动方案商机进入商务' : '补充本月商务储备';
    const nextAction = proposals.length
      ? '逐单确认方案商机的报价和采购节点，明确本月可推进到商务的项目和负责人。'
      : '核对其他阶段商机的采购窗口，确定哪些项目具备在本月进入商务的条件。';
    return decision(S, 'month', title,
      `${gapText}即使本月商务商机全部签下，仍差 ${plainMoney(coverage.afterAll)}。`,
      nextAction, records, '本周确认', members);
  }

  if (coverage.afterReady !== 0) {
    return decision(S, 'month', '优先解除本月商务卡点',
      `${gapText}推进条件明确的商务额 ${amountEvidence(coverage.ready, '条')}，有风险的商务额 ${amountEvidence(risk, '条')}。`,
      '和负责人逐单确认阻碍。优先处理报价过期、跟进逾期以及预计签约日已过的商机。',
      risk.length ? risk : coverage.expected, '本周确认', members);
  }

  return decision(S, 'month', '逐单确认本月商务签约节点',
    `${gapText}推进条件明确的商务商机有 ${amountEvidence(coverage.ready, '条')}。`,
    '与负责人核实客户决策和签约安排，逐单确认预计日期及备用推进动作。',
    coverage.ready, '本周确认', members);
}

function quarterlyDecision(S, pipeline) {
  const {month, monthly, quarterly} = pipeline;
  const members = pipeline.members.filter(row => row.quarterAmount != null);
  if (quarterly.target > 0 && quarterly.signed.missing) {
    const currentMissing = new Set(signedEvidence(monthly).map(row => row.contract.id));
    const records = signedEvidence(quarterly).filter(row => !currentMissing.has(row.contract.id));
    if (!records.length) return null;
    return decision(S, 'quarter', '核对季度历史签约金额',
      `季度还有 ${records.length} 份历史合同金额待核对。`,
      '逐份核实合同实绩，更新季度剩余签约缺口。', records, '本周核对', members);
  }
  if (!(quarterly.gap > 0)) return null;

  const future = quarterly.coverage.expected.filter(row => row.date.slice(0, 7) > month);
  const gapText = `季度剩余签约缺口 ${plainMoney(quarterly.gap)}。`;
  if (monthly.gap == null) {
    return decision(S, 'quarter', '逐月核对季度商机储备',
      `${gapText}季度剩余月份预计签约 ${amountEvidence(quarterly.coverage.expected, '条')}。`,
      '按预计签约月核对商务节点，并先确认本月目标缺口。',
      quarterly.coverage.expected, '本周盘点', members);
  }

  const afterMonth = Math.max(0, quarterly.gap - monthly.gap);
  const isQuarterEnd = month === quarterly.range.to.slice(0, 7);
  const afterMonthText = afterMonth > 0
    ? `${isQuarterEnd ? '季末前' : '后续月份'}仍需 ${plainMoney(afterMonth)}` : '即可覆盖季度缺口';
  const scenario = monthly.gap === 0 ? gapText : `${gapText}若本月补齐签约目标，${afterMonthText}。`;
  if (isQuarterEnd) {
    return decision(S, 'quarter', '核实季末签约安排',
      `${scenario}本月预计签约 ${amountEvidence(quarterly.coverage.expected, '条')}。`,
      '逐单核对季末前的客户决策、商务条款和签约节点，明确仍需补充的项目。',
      quarterly.coverage.expected, '本周盘点', members);
  }

  const forecast = financeAmount(future, amountOf);
  const extra = forecast.missing ? null : Math.max(0, afterMonth - forecast.total);
  const evidence = `${scenario}目标范围内后续月份预计签约 ${amountEvidence(future, '条')}。`;
  if (extra > 0) {
    return decision(S, 'quarter', '提前补齐季度后续月份储备',
      evidence,
      `按预计签约月补充至少 ${plainMoney(extra)} 的可签项目，并为每个项目确认商务节点。`,
      future, '本周盘点', members);
  }

  return decision(S, 'quarter', '逐月核对季度商务计划',
    evidence,
    '按月份确认报价、客户决策和签约时间，同时补齐预计金额或日期缺项。',
    future, '本周盘点', members);
}

function cashDecision(S, cash) {
  if (!cash.priority.length) return null;
  const undated = cash.priority.filter(row => row.kind === 'undated');
  const groups = [
    ['逾期未收', cash.overdue, '笔'],
    ['七天内到期', cash.upcoming, '笔'],
    ['待补收款日', undated, '笔'],
    ['待安排收款计划', cash.unplanned, '份合同'],
  ];
  const evidence = groups.filter(([, rows]) => rows.length)
    .map(([label, rows, unit]) => `${label} ${amountEvidence(rows, unit)}`).join('。') + '。';
  const needsReview = cash.priority.some(row => row.needsReview || row.amount == null);

  if (cash.overdue.length) {
    const confirm = cash.upcoming.length ? '同步核实近期到期款的付款条件。' : '';
    const check = needsReview ? '先核对标记待核对的计划余额。' : '';
    return decision(S, 'cash', '优先落实逾期款的收款日期', evidence,
      `${check}请负责人逐笔确认新的收款日期。${confirm}`, cash.priority, '今天跟进');
  }
  if (cash.upcoming.length) {
    const check = needsReview ? '先核对标记待核对的计划余额，再' : '';
    return decision(S, 'cash', '确认七天内到期款的付款条件', evidence,
      `${check}请负责人逐笔确认付款条件和预计到账日。`, cash.priority, '本周确认');
  }
  return decision(S, 'cash', '补齐合同收款计划', evidence,
    needsReview ? '先核实合同未收余额，再与负责人补齐收款金额和预计日期。' : '与负责人确认每笔收款的金额和预计日期，登记缺项。',
    cash.priority, '本周补齐');
}

export function analyticsDecisions(S, {pipeline, cash}) {
  return [monthlyDecision(S, pipeline), quarterlyDecision(S, pipeline), cashDecision(S, cash)].filter(Boolean);
}
