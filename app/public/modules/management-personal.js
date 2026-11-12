import {badge, customerName, dateLabel, empty, esc, icon, money, plainMoney, sectionHead, stageBadge} from '../ui.js';
import {businessDate, financeAmount, managementMonth, managementReport, memberMonthlyTarget} from './management-finance.js';
import {workbenchForecast} from './workbench-view-model.js';

const amountKnown = value => typeof value === 'number' && Number.isFinite(value);
const rowAmount = row => row.amount;

function personalScope(S, P) {
  const currentMonth = S.today.slice(0, 7);
  const month = managementMonth(S, P);
  if (S.actor.role === 'sales') return {month, currentMonth, member: S.actor, members: []};
  if (S.actor.role !== 'admin') return {month, currentMonth, member: null, members: []};
  const teamIds = new Set((S.team || []).map(member => String(member.id)));
  for (const record of [...(S.opportunities || []), ...(S.contracts || [])]) teamIds.add(String(record.owner_id));
  const members = (S.users || []).filter(member => !member.developer_admin && member.business_member !== 0 && member.business_member !== false &&
    (member.role === 'sales' || member.role === 'admin' && teamIds.has(String(member.id))));
  const member = members.find(member => String(member.id) === String(P.owner)) ||
    members.find(member => member.role === 'sales' && member.active !== 0 && member.active !== false) || members[0];
  return {month, currentMonth, member, members};
}

const metrics = {
  signed: {label: '新签实绩', date: '签约日', unit: '份合同'},
  receipts: {label: '实际到账', date: '到账日', unit: '笔到账'},
  expected: {label: '预计本月签约', date: '预计签约日', unit: '条商机'},
};

function personalModel(S, P) {
  const scope = personalScope(S, P);
  if (!scope.member) return scope;
  const {member, month, currentMonth} = scope;
  const current = month === currentMonth;
  const report = managementReport(S, {owner: String(member.id), managementMonth: month});
  const expected = current ? report.expected.map(record => ({record, amount: workbenchForecast(record), date: businessDate(record.expected_date)})) : [];
  const signed = report.signed.map(record => ({record, amount: record.amount, date: businessDate(record.sign_date)}));
  const receipts = report.receipts.map(({contract, payment}) => ({record: contract, payment, amount: payment.amount, date: businessDate(payment.pay_date)}));
  const plans = current ? report.plans.filter(plan => plan.date && plan.date.slice(0, 7) <= month) : [];
  const target = memberMonthlyTarget(S, member.id, month);
  return {...scope, current, expected, signed, receipts, plans, target};
}

function amountDisplay(rows, compact = false) {
  const {total, missing} = financeAmount(rows, rowAmount);
  return missing && missing === rows.length ? '待核对' : `${missing ? '已知 ' : ''}${money(total, compact)}`;
}

function recordButton(action, record, name) {
  return `<button type="button" class="text-link" data-action="${action}" data-id="${esc(record.id)}">${esc(name)}</button>`;
}

function recordList(rows, renderRow) {
  const list = items => `<ul class="management-list">${items.map(renderRow).join('')}</ul>`;
  return list(rows.slice(0, 5)) + (rows.length > 5
    ? `<details class="management-more"><summary>查看其余 ${rows.length - 5} 项</summary>${list(rows.slice(5))}</details>` : '');
}

function detailRow(S, type, row) {
  const {record, amount, date, payment} = row;
  const action = {signed: 'contract', receipts: 'collection', expected: 'opportunity'}[type];
  const title = record.name || record.contract_no || (type === 'expected' ? '商机名称待补' : '合同名称待补');
  const customer = record.customer_name || customerName(S, record.customer_id);
  const context = [customer, dateLabel(date), payment?.id ? `到账 #${payment.id}` : ''].filter(Boolean).join(' · ');
  return `<li class="management-list-row"><div>
    ${recordButton(action, record, title)} ${type === 'expected' ? stageBadge(record.stage) : ''}
    <p>${esc(context)}</p>${type === 'expected' ? `<small>${esc(record.next_action?.trim() || '下一步待安排')}</small>` : ''}
    </div><strong>${amountKnown(amount) ? plainMoney(amount) : '金额待核对'}</strong></li>`;
}

function collectionRow(S, {contract, plan, date, amount}) {
  const status = date < S.today ? badge('已逾期', 'danger') : date === S.today ? badge('今日到期', 'warning') : '';
  const context = [contract.customer_name || customerName(S, contract.customer_id), `计划收款 ${dateLabel(date)}`, plan.id ? `计划 #${plan.id}` : ''].filter(Boolean).join(' · ');
  return `<li class="management-list-row"><div>
    ${recordButton('collection', contract, contract.name || contract.contract_no || '合同名称待补')} ${status}
    <p>${esc(context)}</p>
    </div><strong>${amountKnown(amount) ? plainMoney(amount) : '金额待核对'}<small>计划余款</small></strong></li>`;
}

function personalToolbar(S, {member, members, month, currentMonth}) {
  const person = S.actor.role === 'admin' && members.length
    ? `<label>成员<select id="filter-owner" aria-label="看板成员">${members.map(user =>
      `<option value="${esc(user.id)}"${String(user.id) === String(member?.id) ? ' selected' : ''}>${esc(user.name)}${user.active === 0 || user.active === false ? '（已停用）' : ''}</option>`
    ).join('')}</select></label>` : '';
  return `<div class="management-toolbar">
    <p><strong>${esc(member?.name || '未选择成员')}</strong> · ${esc(month)}</p>
    <div class="management-controls">${person}<label>月份<input id="management-month" type="month" value="${esc(month)}" max="${esc(currentMonth)}"></label></div>
  </div>`;
}

function card(label, value, hint, id = '') {
  const body = `<span class="metric-label">${esc(label)}</span><strong class="metric-value">${value}</strong><small>${esc(hint)}</small>`;
  return id ? `<button type="button" class="management-metric" data-action="personal-detail" data-id="${esc(id)}">${body}</button>`
    : `<div class="management-metric">${body}</div>`;
}

function metricHint(model, id) {
  const rows = model[id];
  const {missing} = financeAmount(rows, rowAmount);
  return `${rows.length} ${metrics[id].unit}${missing ? ` · ${missing} 项金额待核对` : ` · 按${metrics[id].date}`}`;
}

function personalMetrics(model) {
  const {target, signed, receipts, expected, current, member} = model;
  const {total, missing} = financeAmount(signed, rowAmount);
  const achieved = target > 0 && !missing ? total / target : null;
  const gap = achieved === null ? null : Math.max(0, target - total);
  const gapHint = achieved === null ? '按月目标和新签实绩计算' : `达成率 ${Math.round(achieved * 100)}%`;
  const targetCard = member.role === 'sales'
    ? card('月度目标', target > 0 ? money(target, true) : '待设置', '季度目标折算月度')
    : card('月度目标', '—', '适用于销售成员');
  return `<section class="management-metrics personal-metrics" aria-label="个人月度概览">
    ${targetCard}
    ${card('新签实绩', amountDisplay(signed, true), metricHint(model, 'signed'), 'signed')}
    ${card('目标差额', gap === null ? '—' : gap === 0 ? '已达成' : money(gap, true), gapHint)}
    ${card('实际到账', amountDisplay(receipts, true), metricHint(model, 'receipts'), 'receipts')}
    ${current ? card('预计本月签约', amountDisplay(expected, true), metricHint(model, 'expected'), 'expected')
      : card('预计签约', '—', '历史预计金额未留存')}
  </section>`;
}

function personalActions(S, {member, month}) {
  const performance = member.role === 'sales'
    ? `<button type="button" class="btn secondary" data-action="team-member-performance" data-id="${esc(member.id)}" data-month="${esc(month)}">查看当月绩效</button>` : '';
  const workbench = S.actor.role === 'sales'
    ? '<a href="#workbench" class="btn secondary">前往工作台</a>'
    : member.active === 0 || member.active === false ? ''
      : `<button type="button" class="btn secondary" data-action="personal-workbench" data-id="${esc(member.id)}">查看当前待办</button>`;
  return performance || workbench ? `<div class="management-actions">${performance}${workbench}</div>` : '';
}

export function personalPage(S, P = {}) {
  const model = personalModel(S, P);
  if (!model.member) return empty('暂无可查看的成员', '从团队管理选择成员后查看个人看板。');
  const {current, expected, plans, month} = model;
  return `<div class="management-personal">
    ${personalToolbar(S, model)}
    ${personalMetrics(model)}
    ${personalActions(S, model)}
    ${current ? `<div class="management-columns">
      <section class="panel">${sectionHead('本月预计签约商机', '按预计签约日')}
        ${expected.length ? recordList(expected, row => detailRow(S, 'expected', row)) : empty('暂无本月预计签约商机', '进行中的商机填写本月预计签约日后会在这里显示。')}</section>
      <section class="panel">${sectionHead('本月收款节点', '含以前月份尚未处理的逾期计划')}
        ${plans.length ? recordList(plans, row => collectionRow(S, row)) : empty('暂无到期收款节点', '本月到期或已经逾期的收款计划会在这里显示。')}</section>
    </div>` : `<p class="form-context">${esc(month)} 的签约和到账可按日期核对。预计签约和收款计划在本月查看。</p>`}
  </div>`;
}

export function personalDetail(S, P, id) {
  if (!Object.hasOwn(metrics, id)) return '';
  const model = personalModel(S, P);
  if (!model.member || id === 'expected' && !model.current) return '';
  const {label, date, unit} = metrics[id];
  const rows = model[id];
  return `<header class="dialog-head"><div><h2>${esc(label)}</h2><p>${esc(model.member.name)} · ${esc(model.month)} · 按${esc(date)}</p></div>
      <button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header>
    <div class="dialog-body management-detail"><p>${rows.length} ${esc(unit)} · ${amountDisplay(rows)}</p>
      ${rows.length ? recordList(rows, row => detailRow(S, id, row)) : empty('所选月份暂无记录')}</div>
    <footer class="dialog-footer"><button type="button" class="btn secondary" data-action="close">关闭</button></footer>`;
}
