import { avatar, badge, empty, esc, icon, isClosedStage, money, plainMoney, salesName, sectionHead } from '../ui.js';
import { financeAmount, managementMonth, managementReport, memberMonthlyTarget } from './management-finance.js';
import { quarterOf, targetsPanel } from './targets.js';
import { workbenchModel } from './workbench-view-model.js';

const severities = [
  ['critical', '严重'],
  ['warning', '预警'],
  ['attention', '关注'],
];
const isMember = user => user.role === 'sales' || user.role === 'admin';
const activeMember = user => user.active !== 0 && user.active !== false;
const ownerId = row => row?.owner_id == null ? '' : String(row.owner_id);

function teamSummary(S, P) {
  const month = managementMonth(S, P);
  const report = managementReport(S, { managementMonth: month, owner: P.owner });
  const users = new Map((S.users || []).filter(isMember).map(user => [String(user.id), user]));
  const roster = new Map((S.team || []).map(user => [String(user.id), user]));
  const records = [
    ...report.active,
    ...report.signed,
    ...report.receipts.map(row => row.contract),
    ...report.overdue.map(row => row.contract),
  ];
  const represented = new Set(records.map(ownerId));
  const knownOwners = new Set([...(S.contracts || []), ...(S.opportunities || [])].map(ownerId));
  const owners = [...users.values()].filter(user =>
    roster.has(String(user.id)) || knownOwners.has(String(user.id)) || String(user.id) === report.owner
  );
  for (const id of represented) {
    if (!roster.has(id) && users.has(id)) roster.set(id, users.get(id));
  }
  const hasOther = [...represented].some(id => !roster.has(id));
  const members = [...roster.values()].filter(user => !report.owner || String(user.id) === report.owner);
  if (hasOther) members.push({ id: null, name: '未分配及其他归属' });

  const activeIds = new Set(report.active.map(o => o.id));
  const risks = workbenchModel(S, report.owner).tasks.filter(task =>
    task.kind === 'opportunity' && activeIds.has(task.id) &&
    (task.bucket !== 'today' || task.level !== 'normal')
  );
  const rows = members.map(member => {
    const owns = record => member.id == null ? !roster.has(ownerId(record)) : ownerId(record) === String(member.id);
    const target = member.id == null ? null : memberMonthlyTarget(S, member.id, month);
    const signed = financeAmount(report.signed.filter(owns), c => c.amount);
    const received = financeAmount(report.receipts.filter(row => owns(row.contract)), row => row.payment.amount);
    const plans = report.overdue.filter(row => owns(row.contract));
    const overdue = financeAmount(plans, row => row.amount);
    const achievement = target > 0 && !signed.missing ? signed.total / target : null;
    const gap = achievement == null ? null : Math.max(0, target - signed.total);
    return {
      member, target, signed, received, overdue, achievement, gap, overdueCount: plans.length,
      risks: risks.filter(task => owns(task.opportunity)).length,
    };
  });
  return { month, report, rows, owners, risks };
}

function amountLabel(value) {
  return value == null ? '—' : plainMoney(value);
}

function totalLabel(amount, compact = false) {
  if (!amount.missing) return compact ? money(amount.total, true) : amountLabel(amount.total);
  if (!amount.total) return '待核对';
  return compact ? money(amount.total, true) : `已知 ${amountLabel(amount.total)}`;
}

const percent = value => value == null ? '—' : `${Math.round(value * 100)}%`;

function options(rows, current) {
  return rows.map(([value, label]) =>
    `<option value="${esc(value)}"${String(value) === String(current ?? '') ? ' selected' : ''}>${esc(label)}</option>`
  ).join('');
}

function detailButton(title, action, id, month) {
  return `<button type="button" class="text-link" data-action="${action}" data-id="${esc(id)}"${month ? ` data-month="${esc(month)}"` : ''}>${esc(title)}</button>`;
}

function teamMetrics(summary, today) {
  const { month, rows, report } = summary;
  const targets = rows.filter(row => row.target > 0);
  const amount = targets.reduce((total, row) => total + row.target, 0);
  const signed = financeAmount(report.signed, c => c.amount);
  const receipts = financeAmount(report.receipts, row => row.payment.amount);
  const overdue = financeAmount(report.overdue, row => row.amount);
  return [
    ['target', '月目标合计', targets.length ? money(amount, true) : '待设置', `${targets.length} 位成员已设月目标`, 'dashboard'],
    ['signed', '月内新签合同', totalLabel(signed, true), `${month} · ${report.signed.length} 份合同${signed.missing ? ` · ${signed.missing} 份金额待核对` : ''}`, 'contracts'],
    ['receipts', '月内实际到账', totalLabel(receipts, true), `${month} · ${report.receipts.length} 笔到账${receipts.missing ? ` · ${receipts.missing} 笔金额待核对` : ''}`, 'wallet'],
    ['overdue', '当前逾期收款', totalLabel(overdue, true), `截至 ${today} · ${report.overdue.length} 笔计划`, 'clock'],
  ].map(([id, label, value, note, ico]) =>
    `<button type="button" class="management-metric" data-action="team-metric" data-id="${id}"><span class="metric-label">${esc(label)}${icon(ico)}</span><strong class="metric-value">${value}</strong><small class="management-metric-note">${esc(note)}</small></button>`
  ).join('');
}

function memberRow(row, month) {
  const { member, target, signed, received, overdue, overdueCount, achievement, gap, risks } = row;
  const title = member.id == null ? '历史或未分配归属' :
    !activeMember(member) ? '已停用' : member.role === 'admin' ? '销售负责人' : '销售';
  const values = [
    ['月目标', target > 0 ? amountLabel(target) : member.role === 'sales' ? '待设置' : '—'],
    ['新签实绩', totalLabel(signed)],
    ['达成率', percent(achievement)],
    ['目标缺口', amountLabel(gap)],
    ['实际到账', totalLabel(received)],
    ['逾期收款', totalLabel(overdue)],
  ];
  const personal = member.id != null && !member.developer_admin && member.business_member !== 0
    ? detailButton('个人看板', 'person-board', member.id, month) : '';
  const performance = member.role === 'sales' ? detailButton('当月绩效', 'team-member-performance', member.id, month) : '';
  const commission = member.id != null ? detailButton('实时提成', 'team-member-commission', member.id, month) : '';
  return `<article class="team-member-row" data-team-member="${esc(member.id ?? 'other')}">
    <div class="team-member-identity">${avatar(member.name, true)}<div><h3>${esc(member.name)}</h3><span>${esc(title)} · ${risks} 个商机风险 · ${overdueCount} 笔收款逾期</span></div></div>
    <dl class="team-member-values">${values.map(([label,value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>
    <div class="team-member-actions">${personal}${performance}${commission}</div>
  </article>`;
}

function riskPanel(S, P, summary) {
  const stage = P.teamRiskStage || '';
  const severity = P.teamRiskLevel || '';
  const rows = summary.risks.filter(task =>
    (!stage || task.opportunity.stage === stage) && (!severity || task.level === severity)
  );
  const stages = (S.stages || []).filter(stage => !isClosedStage(stage));
  const list = rows.map(task => {
    const { opportunity } = task;
    const level = severities.find(([id]) => id === task.level)?.[1] || '待处理';
    return `<li class="team-risk-row"><div><strong>${detailButton(opportunity.name || opportunity.code || '商机详情', 'opportunity', opportunity.id)}</strong>
      <small>${esc(salesName(S, opportunity))} · ${esc(opportunity.stage)}${task.date ? ` · 跟进 ${esc(task.date)}` : ''}</small>
      <p>${esc(task.reason)}${opportunity.next_action ? ` · ${esc(opportunity.next_action)}` : ''}</p></div>
      ${badge(level, task.level === 'critical' ? 'danger' : 'warning')}</li>`;
  }).join('');
  return `<section class="panel team-risk-panel">
    ${sectionHead('当前风险盯办', `截至 ${S.today} · ${rows.length} 个商机`)}
    <div class="management-controls team-risk-filters">
      <label>阶段<select id="team-risk-stage" aria-label="风险商机阶段">${options([['', '全部阶段'], ...stages.map(value => [value, value])], stage)}</select></label>
      <label>风险<select id="team-risk-level" aria-label="风险等级">${options([['', '全部等级'], ...severities], severity)}</select></label>
    </div>
    ${rows.length ? `<ul class="team-risk-list">${list}</ul>` : empty('暂无匹配的风险商机','可切换阶段或风险等级。')}
  </section>`;
}

export function teamManagement(S, P = {}) {
  if (S.actor.role !== 'admin') return empty('当前账号无权访问');
  const summary = teamSummary(S, P);
  const { month, rows, owners, report } = summary;
  const scope = report.owner ? owners.find(user => String(user.id) === report.owner)?.name || '所选负责人' : '全体团队';
  const targetSettings = targetsPanel(S, { ...P, owner: report.owner, targetQuarter: P.targetQuarter || quarterOf(month) });
  return `<section class="panel management-toolbar team-toolbar">
    <div class="management-controls">
      <label>统计月份<input type="month" id="management-month" value="${esc(month)}" max="${esc(S.today.slice(0, 7))}" aria-label="团队统计月份"></label>
      <label>负责人<select id="filter-owner" aria-label="团队负责人">${options([['','全体团队'], ...owners.map(user => [user.id,user.name])], report.owner)}</select></label>
      <button type="button" class="btn secondary" data-action="export-team">${icon('download')} 导出团队战报</button>
    </div>
  </section>
  <div class="management-metrics" aria-label="${esc(scope)} · ${esc(month)}业绩概览">${teamMetrics(summary, S.today)}</div>
  <section class="panel team-member-panel">
    ${sectionHead('成员目标与实绩', `${scope} · ${month}`)}
    <div class="team-member-list">${rows.length ? rows.map(row => memberRow(row, month)).join('') : empty('暂无匹配成员')}</div>
  </section>
  <details class="team-targets"${P.teamTargetsOpen ? ' open' : ''}><summary>维护季度目标</summary>${targetSettings}</details>
  ${riskPanel(S, P, summary)}`;
}

export function teamMetricDetail(S, P, id) {
  if (S.actor.role !== 'admin') return '';
  const { month, rows, report } = teamSummary(S, P);
  const details = {
    target: ['月目标明细', month, rows.filter(row => row.target > 0).map(row => ({
      title: row.member.name, meta: quarterOf(month) + ' 季度目标折算', amount: row.target,
    }))],
    signed: ['月内签约明细', month, report.signed.map(contract => ({
      title: contract.name || contract.code || '合同',
      meta: [contract.sign_date, contract.code, salesName(S, contract)].filter(Boolean).join(' · '),
      amount: contract.amount, action: 'contract', id: contract.id,
    }))],
    receipts: ['月内到账明细', month, report.receipts.map(({ contract, payment }) => ({
      title: contract.name || contract.code || '合同',
      meta: [payment.pay_date, payment.id ? `到账 #${payment.id}` : '', salesName(S, contract)].filter(Boolean).join(' · '),
      amount: payment.amount, action: 'collection', id: contract.id,
    }))],
    overdue: ['当前逾期收款明细', `截至 ${S.today}`, report.overdue.map(({ contract, plan, date, amount }) => ({
      title: contract.name || contract.code || '合同',
      meta: [date, plan.id ? `计划 #${plan.id}` : '', salesName(S, contract)].filter(Boolean).join(' · '),
      amount, action: 'collection', id: contract.id,
    }))],
  };
  if (!Object.hasOwn(details, id)) return '';
  const [title, date, list] = details[id];
  const total = financeAmount(list, row => row.amount);
  return `<header class="dialog-head"><div><h2>${title}</h2><p>${esc(date)} · ${list.length} 项 · ${esc(totalLabel(total))}${total.missing ? ` · ${total.missing} 项金额待核对` : ''}</p></div><button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header>
    <div class="dialog-body management-detail">${list.length ? `<ul class="management-detail-list">${list.map(row =>
      `<li><div>${row.action ? detailButton(row.title, row.action, row.id) : `<strong>${esc(row.title)}</strong>`}<small>${esc(row.meta)}</small></div><strong>${esc(amountLabel(row.amount))}</strong></li>`
    ).join('')}</ul>` : empty('暂无明细')}</div><footer class="dialog-footer"><button type="button" class="btn secondary" data-action="close">关闭</button></footer>`;
}

export function teamExportRows(S, P = {}) {
  if (S.actor.role !== 'admin') return [];
  const { month, rows } = teamSummary(S, P);
  return [
    ['统计月份', '成员或业务归属', '月目标(元)', '已知新签实绩(元)', '新签待核对数', '达成率', '目标缺口(元)', '已知实际到账(元)', '到账待核对数', '逾期统计截至', '已知逾期收款(元)', '逾期计划数'],
    ...rows.map(row => [
      month, row.member.name, row.target == null ? '' : row.target / 100,
      row.signed.total / 100, row.signed.missing, row.achievement == null ? '' : percent(row.achievement),
      row.gap == null ? '' : row.gap / 100, row.received.total / 100, row.received.missing,
      S.today, row.overdue.total / 100, row.overdueCount,
    ]),
  ];
}
