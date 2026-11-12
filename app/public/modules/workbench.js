import { badge, customerName, empty, esc, icon, money, plainMoney, salesName, sectionHead, shortDate, userName } from '../ui.js';
import { canManageContract } from './contract-access.js';
import { pipeline } from './shared.js';
import { workbenchForecast, workbenchModel } from './workbench-view-model.js';
import { workbenchRecent } from './workbench-recent.js';

const buckets = [
  ['overdue', '已逾期'],
  ['today', '今日到期'],
  ['risk', '风险待处理'],
];
const metricTitles = {
  expected: '预计本月签约',
  signed: '本月新签合同',
  receipts: '本月实际到账',
};
const knownAmount = value => typeof value === 'number' && Number.isFinite(value);
const amountText = value => knownAmount(value) ? plainMoney(value) : '金额待补';
const metricAmounts = {
  expected: workbenchForecast,
  signed: c => c.amount,
  receipts: ({ payment }) => payment.amount,
};
const customer = (S, record) => record.customer_name || customerName(S, record.customer_id);
const scopeLabel = (S, owner) => S.actor.role === 'admin'
  ? owner ? userName(S, owner) : '团队'
  : S.actor.role === 'pm' ? '我的协作范围' : '本人';

function summarize(rows, amount) {
  const known = rows.map(amount).filter(knownAmount);
  return { total: known.reduce((sum, value) => sum + value, 0), missing: rows.length - known.length };
}

function detailButton(label, action, id) {
  return `<button type="button" class="text-link" data-action="${action}" data-id="${esc(id)}">${esc(label)}</button>`;
}

function metricCard(id, label, value, note, symbol) {
  return `<button type="button" class="workbench-metric" data-action="workbench-metric" data-id="${id}">
    <span class="metric-label">${label}${icon(symbol)}</span>
    <strong class="metric-value">${value}</strong>
    <span class="workbench-metric-note">${esc(note)}</span>
  </button>`;
}

function metrics(S, model) {
  const overdue = model.tasks.filter(task => task.bucket === 'overdue').length;
  const today = model.tasks.filter(task => task.bucket === 'today').length;
  const cards = [
    ['expected', 'opportunities', '个商机', '按预计签约日'],
    ['signed', 'contracts', '份合同', '按签约日'],
    ['receipts', 'wallet', '笔到账', '按实际到账日'],
  ].map(([id, symbol, unit, basis]) => {
    const rows = model[id], { total, missing } = summarize(rows, metricAmounts[id]);
    const value = rows.length && missing === rows.length ? '待核对' : money(total, true);
    return metricCard(id, metricTitles[id], value, `${rows.length} ${unit} · ${missing ? `${missing} 项金额待补` : basis}`, symbol);
  });
  return `<section class="workbench-metrics" aria-label="${esc(scopeLabel(S, model.owner))} · ${model.month}业务概览">
    ${metricCard('tasks', '待处理事项', `${model.tasks.length}<small>项</small>`, `逾期 ${overdue} · 今日 ${today} · 风险 ${model.tasks.length - overdue - today}`, 'clock')}
    ${cards.join('')}
  </section>`;
}

function taskRow(S, task) {
  const isCollection = task.kind === 'collection';
  const record = isCollection ? task.contract : task.opportunity;
  const title = record.name || (isCollection ? '合同名称待补' : '商机名称待补');
  const target = isCollection ? 'collection' : 'opportunity';
  const canAct = isCollection ? canManageContract(S, record) : ['admin', 'sales'].includes(S.actor.role);
  const action = isCollection ? 'collection-receive' : 'new-activity';
  const who = S.actor.role === 'admin' ? ` · ${salesName(S, record)}` : '';
  const date = task.date ? `${isCollection ? '预计收款' : '跟进'} ${shortDate(task.date)}` : '跟进日期未设置';
  return `<li class="workbench-task-row" data-task-kind="${task.kind}" data-task-id="${esc(task.id)}">
    <div class="workbench-task-copy">
      <div class="workbench-task-title">${detailButton(customer(S, record), target, record.id)}
        ${badge(isCollection ? '收款计划' : record.stage, isCollection ? 'neutral' : 'blue')}</div>
      <p class="workbench-task-name">${esc(title)}</p>
      ${!isCollection && record.next_action?.trim() ? `<p>${esc(record.next_action)}</p>` : ''}
      <p class="workbench-task-reason" data-bucket="${task.bucket}">${esc(task.reason)}</p>
      <small>${esc(date + who)}${!isCollection && record.expected_date ? ` · 预计签约 ${esc(shortDate(record.expected_date))}` : ''}</small>
    </div>
    <div class="workbench-task-end">
      <span class="workbench-task-amount">${esc(amountText(task.amount))}${isCollection ? '<small>计划余款</small>' : '<small>预计金额</small>'}</span>
      ${canAct ? `<button type="button" class="btn secondary" data-action="${action}" data-id="${esc(task.id)}">${isCollection ? '登记到账' : '记录跟进'}</button>` : ''}
    </div>
  </li>`;
}

function tasks(S, P, model) {
  const filter = buckets.some(([id]) => id === P.workbenchTask) ? P.workbenchTask : 'all';
  const list = filter === 'all' ? model.tasks : model.tasks.filter(task => task.bucket === filter);
  const visible = P.workbenchAll ? list : list.slice(0, 5);
  const filters = [['all', '全部'], ...buckets].map(([id, label]) => {
    const count = id === 'all' ? model.tasks.length : model.tasks.filter(task => task.bucket === id).length;
    return `<button type="button" data-action="workbench-task-filter" data-id="${id}" aria-pressed="${id === filter}">${label} <b>${count}</b></button>`;
  }).join('');
  const groups = buckets.map(([id, label]) => {
    const rows = visible.filter(task => task.bucket === id);
    return rows.length ? `<div class="workbench-task-group"><h3>${label}</h3><ul>${rows.map(task => taskRow(S, task)).join('')}</ul></div>` : '';
  }).join('');
  const expand = list.length > 5
    ? `<button type="button" class="panel-link" data-action="workbench-task-expand" aria-expanded="${Boolean(P.workbenchAll)}">${P.workbenchAll ? '收起清单' : `查看全部 ${list.length} 项`} ${icon('arrow')}</button>` : '';
  return `<section class="panel workbench-tasks" id="workbench-tasks" tabindex="-1">
    ${sectionHead('待办清单', '')}
    <div class="workbench-task-filters" role="group" aria-label="筛选待办">${filters}</div>
    ${groups || empty('暂无此类待办', filter === 'all' ? '当前范围没有到期跟进、收款计划或风险提醒。' : '可切换到其他待办范围。')}
    ${expand}
  </section>`;
}

function recent(S, owner) {
  const rows = workbenchRecent(S, owner);
  return `<section class="panel workbench-recent">
    ${sectionHead('最近跟进', '', `<button type="button" class="text-link" data-action="workbench-timeline">查看时间线 ${icon('arrow')}</button>`)}
    ${rows.length ? `<ul>${rows.map(row => `<li>
      <button type="button" class="workbench-recent-link" data-action="${row.action}" data-id="${esc(row.id)}">
        <strong>${esc(row.customer)}</strong>
        <span>${esc(row.summary)}</span>
        <small>${esc([row.author, row.source, shortDate(row.date)].filter(Boolean).join(' · '))}</small>
      </button>
      ${row.opportunityId ? detailButton('查看商机', 'opportunity', row.opportunityId) : ''}
    </li>`).join('')}</ul>` : empty('暂无最近跟进', '此范围的跟进记录会显示在这里。')}
  </section>`;
}

export function workbench(S, P = {}) {
  const model = workbenchModel(S, P.owner);
  const ownerFilter = S.actor.role === 'admin'
    ? `<label class="workbench-owner">负责人 <select id="workbench-owner" aria-label="工作台负责人">
      <option value="">全部负责人</option>
      ${model.owners.map(user => `<option value="${esc(user.id)}"${String(user.id) === model.owner ? ' selected' : ''}>${esc(user.name)}</option>`).join('')}
    </select></label>` : '';
  const stageOpps = model.active.map(o => ({ ...o, amount: workbenchForecast(o) }));
  const missing = stageOpps.filter(o => !knownAmount(o.amount)).length;
  return `<link rel="stylesheet" href="./modules/workbench.css">
    <div class="workbench-scope"><span>${esc(scopeLabel(S, model.owner))} · ${model.month}</span>${ownerFilter}</div>
    ${metrics(S, model)}
    <div class="workbench-layout">
      ${tasks(S, P, model)}
      <div class="workbench-aside">
        <section class="panel workbench-pipeline">
          ${sectionHead('在途商机预计金额', `按推进阶段汇总 · ${model.active.length} 个商机${missing ? ` · ${missing} 个金额待补` : ''}`)}
          ${pipeline({ ...S, opportunities: stageOpps }, false)}
          <button type="button" class="panel-link" data-action="workbench-active">查看进行中商机 ${icon('arrow')}</button>
        </section>
        ${recent(S, model.owner)}
      </div>
    </div>`;
}

export function workbenchMetricDetail(S, owner, id) {
  if (!Object.hasOwn(metricTitles, id)) return '';
  const model = workbenchModel(S, owner);
  const rows = model[id];
  const { total, missing } = summarize(rows, metricAmounts[id]);
  const totalText = missing && missing === rows.length ? '金额待核对' : `${missing ? '已知金额 ' : '合计 '}${plainMoney(total)}`;
  const dateBasis = { expected: '预计签约日', signed: '签约日', receipts: '实际到账日' }[id];
  const body = rows.map(row => {
    const isReceipt = id === 'receipts';
    const record = isReceipt ? row.contract : row;
    const action = { expected: 'opportunity', signed: 'contract', receipts: 'collection' }[id];
    const date = { expected: record.expected_date, signed: record.sign_date, receipts: row.payment?.pay_date }[id];
    return `<li><div>${detailButton(customer(S, record), action, record.id)}
      <p>${esc(record.name || '名称待补')}${isReceipt && row.payment.id ? ` · 到账 #${esc(row.payment.id)}` : ''}</p>
      <small>${esc([date?.slice(0, 10), S.actor.role === 'admin' ? salesName(S, record) : ''].filter(Boolean).join(' · '))}</small>
      </div><strong>${esc(amountText(metricAmounts[id](row)))}</strong></li>`;
  }).join('');
  return `<header class="dialog-head"><div><h2>${metricTitles[id]}</h2>
      <p>${esc(scopeLabel(S, model.owner))} · ${model.month} · 按${dateBasis}</p></div>
      <button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header>
    <div class="dialog-body workbench-detail"><p class="workbench-detail-total">${rows.length} 项 · ${totalText}${missing ? ` · ${missing} 项金额待补` : ''}</p>
      ${body ? `<ul>${body}</ul>` : empty('本月暂无记录', '此范围暂时没有符合统计口径的记录。')}</div>
    <footer class="dialog-footer"><button type="button" class="btn secondary" data-action="close">关闭</button></footer>`;
}
