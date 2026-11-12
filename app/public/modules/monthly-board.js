import { customerName, dateLabel, empty, esc, icon, isClosedStage, money, plainMoney, salesName, userName } from '../ui.js';
import { selectActivityGroups } from './activities.js';
import { selectOpportunities } from './opportunity-view-model.js';
import { workbenchForecast } from './workbench-view-model.js';

const chinaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
const datePart = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';

function createdDate(value) {
  if (!value) return '';
  if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return datePart(value);
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : chinaDate.format(date);
}

const inMonth = (date, month) => !!date && date.startsWith(month + '-');
const newestFirst = (a, b) => b.date.localeCompare(a.date) || Number(b.record.id) - Number(a.record.id);
const validMoney = value => Number.isSafeInteger(value) && value >= 0;
const sumKnown = values => values.filter(validMoney).reduce((sum, value) => sum + value, 0);

function signingGroups(S, month, key) {
  const groups = new Map();
  for (const contract of S.contracts || []) {
    const id = contract[key], date = datePart(contract.sign_date);
    if (id == null || contract.lifecycle === '草稿' || contract.terminated_at || contract.retired_at || !inMonth(date, month) || date > S.today) continue;
    if (S.actor.role === 'sales' && Number(contract.owner_id) !== Number(S.actor.id)) continue;
    if (!groups.has(Number(id))) groups.set(Number(id), []);
    groups.get(Number(id)).push(contract);
  }
  return groups;
}

const mostRecentSigning = contracts => contracts.reduce((date, contract) => datePart(contract.sign_date) > date ? datePart(contract.sign_date) : date, '');

function customerFollowupDates(S) {
  const opportunities = new Map((S.opportunities || []).map(o => [Number(o.id), o]));
  const dates = new Map();
  for (const group of selectActivityGroups(S)) {
    for (const event of group.events) {
      const opportunity = opportunities.get(Number(event.opportunity_id));
      const id = opportunity?.customer_id ?? event.customer_id;
      const date = datePart(event.activity_date);
      if (id == null || !date || date > S.today || event.voided_at || event.source_withdrawn || ['系统', '系统里程碑'].includes(event.activity_type) || ['系统', '系统里程碑'].includes(event.source)) continue;
      const key = Number(id);
      if (!dates.has(key) || date > dates.get(key)) dates.set(key, date);
    }
  }
  return dates;
}

function customerCards(S, P, month) {
  const owner = S.actor.role === 'sales' || P.customerScope === 'mine' ? S.actor.id : S.actor.role === 'admin' ? P.owner : '';
  const scope = owner ? Number(owner) === Number(S.actor.id) ? '我的客户' : userName(S, owner) : S.actor.role === 'admin' ? '团队客户' : '关联客户';
  const customers = (S.customers || []).filter(c => !c.shared && (!owner || Number(c.owner_id) === Number(owner)));
  const followed = customerFollowupDates(S), signed = signingGroups(S, month, 'customer_id');
  const created = customers.map(record => ({record, date:createdDate(record.created_at)}))
    .filter(row => inMonth(row.date, month) && row.date <= S.today);
  const card = (id, label, iconName, description, rows) => ({
    id:'customer-' + id, label, icon:iconName, description, rows:rows.sort(newestFirst), unit:'家',
  });
  return {scope, cards:[
    card('new', '本月新增客户', 'customers', '按客户建档日期', created),
    card('followed', '本月已跟进客户', 'activities', '按有效跟进日期去重', customers.flatMap(record => {
      const date = followed.get(Number(record.id));
      return inMonth(date, month) ? [{record, date}] : [];
    })),
    card('signed', '本月签约客户', 'contracts', '按有效合同签约日期去重', customers.flatMap(record => {
      const contracts = signed.get(Number(record.id));
      return contracts ? [{record, date:mostRecentSigning(contracts), contracts}] : [];
    })),
    card('first-followup', '本月新增待首跟', 'clock', '本月建档且暂无有效跟进', created.filter(row => !followed.has(Number(row.record.id)))),
  ]};
}

function opportunityCards(S, P, month) {
  const owner = S.actor.role === 'admin' && P.opportunityView !== 'ledger' ? P.owner : '';
  const scope = owner ? userName(S, owner) : {admin:'团队商机', sales:'我的商机', pm:'关联商机'}[S.actor.role];
  const rows = selectOpportunities(S, {owner, risk:'all'}).filter(o => !o.archived_at);
  const active = rows.filter(o => !isClosedStage(o.stage));
  const signed = signingGroups(S, month, 'opportunity_id');
  const card = (id, label, iconName, description, rows, showAmount = false) => ({
    id:'opportunity-' + id, label, icon:iconName, description, rows, showAmount, unit:'条',
  });
  const due = selectOpportunities({...S, opportunities:active}, {owner, risk:'today'})
    .map(record => ({record, date:datePart(record.follow_date)}));
  return {scope, cards:[
    card('new', '本月新增商机', 'opportunities', '按商机创建日期', rows.map(record => ({record, date:createdDate(record.created_at)}))
      .filter(row => inMonth(row.date, month) && row.date <= S.today).sort(newestFirst)),
    card('expected', '预计本月签约', 'clock', '按进行中商机的预计签约日期', active.filter(o => inMonth(datePart(o.expected_date), month))
      .map(record => ({record, date:datePart(record.expected_date), amount:workbenchForecast(record)}))
      .sort((a, b) => a.date.localeCompare(b.date)), true),
    card('signed', '本月有效签约', 'contracts', '按关联合同实际签约日期', rows.flatMap(record => {
      const contracts = signed.get(Number(record.id));
      if (!contracts) return [];
      const amounts = contracts.map(c => c.amount);
      return [{record, date:mostRecentSigning(contracts), contracts, amount:amounts.some(validMoney) ? sumKnown(amounts) : null}];
    }).sort(newestFirst), true),
    card('due', '当前待跟进', 'activities', '今日到期及逾期，含跨月', due),
  ]};
}

function board(S, P, kind) {
  const month = S.today.slice(0, 7);
  return {month, ...(kind === 'customer' ? customerCards(S, P, month) : opportunityCards(S, P, month))};
}

function amountSummary(card) {
  const amounts = card.rows.flatMap(row => row.contracts ? row.contracts.map(c => c.amount) : [row.amount]);
  const missing = amounts.filter(value => !validMoney(value)).length;
  return {total:sumKnown(amounts), missing, allMissing:!!missing && missing === amounts.length};
}

function summaryValue(card, compact) {
  if (!card.showAmount) return `${card.rows.length}<small>${card.unit}</small>`;
  const {total, allMissing} = amountSummary(card);
  return allMissing ? '待核对' : money(total, compact);
}

function summaryCaption(card) {
  if (!card.showAmount) return card.description;
  const {missing} = amountSummary(card);
  const count = `${card.rows.length} 条商机`;
  return card.id === 'opportunity-signed'
    ? `${count} · ${card.rows.reduce((total, row) => total + row.contracts.length, 0)} 份合同${missing ? ` · ${missing} 份金额待补` : ''}`
    : `${count}${missing ? ` · ${missing} 条金额待评估` : ''}`;
}

export function monthlyBoard(S, P, kind) {
  if (!datePart(S.today)) return '';
  const {scope, month, cards} = board(S, P, kind);
  return `<link rel="stylesheet" href="./modules/monthly-board.css"><section class="monthly-board" aria-label="月度业务概览"><p class="monthly-board-scope">${esc(scope)} · ${esc(month)}<span>概览不随列表搜索变化</span></p><div class="monthly-board-grid">${cards.map(card =>
    `<button type="button" class="monthly-board-card" data-action="monthly-board-detail" data-id="${card.id}"><span class="monthly-board-label">${esc(card.label)}${icon(card.icon)}</span><strong class="monthly-board-value">${summaryValue(card, true)}</strong><span class="monthly-board-note">${esc(summaryCaption(card))}</span></button>`
  ).join('')}</div></section>`;
}

function contractEvidence(contracts) {
  if (!contracts?.length) return '';
  return `<details class="monthly-board-contracts"><summary>查看 ${contracts.length} 份签约合同</summary><ul>${contracts.map(contract =>
    `<li><button type="button" class="text-link" data-action="contract" data-id="${esc(contract.id)}">${esc(contract.contract_no || contract.name || '合同')}</button><span>${esc(dateLabel(contract.sign_date))} · ${validMoney(contract.amount) ? plainMoney(contract.amount) : '金额待补'}</span></li>`
  ).join('')}</ul></details>`;
}

export function monthlyBoardDetail(S, P, id) {
  const kind = String(id || '').split('-')[0];
  if (!datePart(S.today) || !['customer', 'opportunity'].includes(kind)) return '';
  const {scope, month, cards} = board(S, P, kind);
  const card = cards.find(card => card.id === id);
  if (!card) return '';
  const detailSummary = card.showAmount
    ? `${summaryCaption(card)} · ${summaryValue(card, false)}`
    : `${card.rows.length} ${card.unit}${kind === 'customer' ? '客户' : '商机'}`;
  const rows = card.rows.map(({record, date, amount, contracts}) => {
    const title = kind === 'customer' ? record.name : record.name || '售卖产品待补充';
    const metadata = [kind === 'opportunity' && customerName(S, record.customer_id), salesName(S, record)].filter(Boolean).join(' · ');
    const partial = contracts?.some(c => !validMoney(c.amount));
    const rowAmount = card.showAmount ? validMoney(amount) ? (partial ? '已知 ' : '') + plainMoney(amount) : '金额待核对' : '';
    return `<article class="monthly-board-detail-row"><div class="monthly-board-detail-record"><div><button type="button" class="text-link" data-action="${kind}" data-id="${esc(record.id)}">${esc(title)}</button><span>${esc(metadata)}</span></div><div><time datetime="${esc(date)}">${esc(dateLabel(date))}</time>${rowAmount ? `<strong>${rowAmount}</strong>` : ''}</div></div>${contractEvidence(contracts)}</article>`;
  }).join('');
  return `<header class="dialog-head"><div><h2>${esc(card.label)}</h2><p>${esc(scope)} · ${esc(card.id === 'opportunity-due' ? S.today : month)} · ${esc(card.description)}</p></div><button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="dialog-body monthly-board-detail"><p class="monthly-board-detail-total">${detailSummary}</p>${rows || empty('暂无对应记录')}</div><footer class="dialog-footer"><button type="button" class="btn secondary" data-action="close">关闭</button></footer>`;
}
