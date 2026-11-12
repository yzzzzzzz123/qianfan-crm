import {customerName, dateLabel, empty, esc, icon, money, plainMoney, salesName, sectionHead, userName} from '../ui.js';
import {businessDate, financeAmount, managementReport} from './management-finance.js';

const categories = [
  ['self', '新签自建'], ['assigned', '新签分发'], ['renewal', '续费'], ['expansion', '增购'], ['unknown', '未分类'],
];
const categoryId = new Map(categories.map(([id, label]) => [label, id]));
const presets = {'this-month': '本月', 'last-month': '上月', 'this-quarter': '本季度'};
const periodName = P => P.from || P.to || P.managementPreset === 'custom' ? '本期' : presets[P.managementPreset] || '本月';
const periodDates = ({from, to}) => `${from || '最早记录'} 至 ${to || '最新记录'}`;
const valueOf = row => row.amount;
const marginOf = row => row.total_margin;
const receiptAmount = row => row.payment.amount;
const amountKnown = amount => typeof amount === 'number' && Number.isFinite(amount);

function validDay(value) {
  const day = businessDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const date = new Date(day + 'T00:00:00Z');
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== day ? '' : day;
}

function receiptSource({contract, payment}, {from, to}, today) {
  const signedOn = validDay(contract.sign_date);
  const paidOn = validDay(payment.pay_date);
  if (!signedOn) return {id: 'unclassified', signedOn, paidOn, reason: '签约日期待核对'};
  const advance = paidOn && paidOn < signedOn ? '签约前到账' : '';
  if (signedOn > today) return {id: 'unclassified', signedOn, paidOn, reason: '签约日晚于统计日'};
  if (to && signedOn > to) {
    return {id: 'unclassified', signedOn, paidOn, reason: '签约日在统计区间之后'};
  }
  return {id: from && signedOn < from ? 'historical-contracts' : 'current-contracts', signedOn, paidOn, reason: advance};
}

function contractCashData(S, P, data) {
  const report = data?.report || managementReport(S, P);
  const contractGroups = new Map(categories.map(([id]) => [id, []]));
  const opportunityTypes = new Map((S.opportunities || []).map(row => [Number(row.id), row.sale_type]));
  for (const contract of report.signed) {
    const type = contract.sale_type || opportunityTypes.get(Number(contract.opportunity_id));
    contractGroups.get(categoryId.get(type) || 'unknown').push(contract);
  }
  const receiptGroups = {
    'current-contracts': [],
    'historical-contracts': [],
    unclassified: [],
  };
  for (const row of report.receipts) {
    const source = receiptSource(row, report.range, S.today);
    receiptGroups[source.id].push({...row, ...source});
  }
  return {report, contractGroups, receiptGroups};
}

function totalValue(amount, rows, compact = false) {
  if (rows.length && amount.missing === rows.length) return '待核对';
  return compact ? money(amount.total, true) : plainMoney(amount.total);
}

function countNote(rows, amount, unit, unknownLabel) {
  return `${rows.length} ${unit}${amount.missing ? ` · ${amount.missing} ${unit}${unknownLabel}` : ''}`;
}

function metric(id, label, rows, value, unit, symbol, unknownLabel = '金额待核对') {
  const amount = financeAmount(rows, value);
  return `<button type="button" class="management-metric analytics-metric" data-action="management-analytics-detail" data-id="${id}">
    <span class="management-metric-label">${esc(label)}${icon(symbol)}</span>
    <strong class="management-metric-value">${totalValue(amount, rows, true)}</strong>
    <span class="management-metric-note">${esc(countNote(rows, amount, unit, unknownLabel))}</span>
  </button>`;
}

const receiptLabels = P => ({
  'current-contracts': periodName(P) + '新签合同回款',
  'historical-contracts': '历史合同回款',
  unclassified: '其他到账归属',
});

export function analyticsContractCash(S, P, data) {
  const {report, contractGroups, receiptGroups} = contractCashData(S, P, data);
  if (report.invalid) return '';
  const labels = receiptLabels(P);
  const signed = financeAmount(report.signed, valueOf);
  const receipts = financeAmount(report.receipts, receiptAmount);
  const receiptCards = Object.keys(labels).filter(id => id !== 'unclassified' || receiptGroups[id].length);
  return `<section class="management-section analytics-section analytics-contract-structure">
    ${sectionHead('合同结构与毛利', `${periodDates(report.range)} · ${countNote(report.signed, signed, '份合同', '金额待核对')} · 签约额 ${totalValue(signed, report.signed)}`)}
    <div class="management-metrics management-three">
      ${categories.map(([id, label]) => metric('contract-category-' + id, label, contractGroups.get(id), valueOf, '份合同', 'contracts')).join('')}
      ${metric('contract-margin', '扣费后毛利', report.signed, marginOf, '份合同', 'chart', '毛利待核对')}
    </div>
  </section>
  <section class="management-section analytics-section analytics-receipt-sources">
    ${sectionHead('回款来源', `${periodDates(report.range)} · 按实际到账日 · ${countNote(report.receipts, receipts, '笔到账', '金额待核对')} · 实际到账 ${totalValue(receipts, report.receipts)}`)}
    <div class="management-metrics ${receiptCards.length === 3 ? 'management-three' : 'management-columns'}">
      ${receiptCards.map(id => metric('cash-' + id, labels[id], receiptGroups[id], receiptAmount, '笔到账', 'wallet')).join('')}
    </div>
  </section>`;
}

const rowAmount = amount => amountKnown(amount) ? plainMoney(amount) : '待核对';

function recordRow(S, contract, action, amount, detail) {
  const name = contract.name || contract.contract_no || contract.customer_name || customerName(S, contract.customer_id);
  const context = [contract.customer_name || customerName(S, contract.customer_id), salesName(S, contract), ...detail].filter(Boolean);
  return `<li class="management-list-row analytics-list-row">
    <div><button type="button" class="text-link" data-action="${action}" data-id="${esc(contract.id)}">${esc(name)}</button>
      <small>${esc(context.join(' · '))}</small>
    </div><strong>${rowAmount(amount)}</strong>
  </li>`;
}

function signedRow(S, row, includeMargin) {
  const date = validDay(row.sign_date);
  const amount = includeMargin ? row.total_margin : row.amount;
  const detail = [date ? '签约 ' + dateLabel(date) : '签约日期待核对'];
  if (includeMargin) {
    detail.push('合同额 ' + rowAmount(row.amount));
    if (amountKnown(row.business_expense)) detail.push('合同费用 ' + plainMoney(row.business_expense));
  }
  return recordRow(S, row, 'contract', amount, detail);
}

function receiptRow(S, row) {
  const {contract, payment, signedOn, paidOn, reason} = row;
  return recordRow(S, contract, 'collection', payment.amount, [
    signedOn ? '签约 ' + dateLabel(signedOn) : '',
    paidOn ? '到账 ' + dateLabel(paidOn) : '到账日期待核对',
    payment.id && '到账 #' + payment.id,
    reason,
  ]);
}

function drawer(S, P, report, title, rows, value, unit, unknownLabel, render) {
  const amount = financeAmount(rows, value);
  const context = [
    report.owner ? userName(S, report.owner) : '全部负责人',
    P.level && `${P.level} 级客户`,
    P.saleType,
    periodDates(report.range),
  ].filter(Boolean).join(' · ');
  return `<header class="dialog-head"><div><h2>${esc(title)}</h2><p>${esc(context)}</p></div>
      <button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header>
    <div class="dialog-body management-detail analytics-detail">
      <p class="management-detail-total">${esc(countNote(rows, amount, unit, unknownLabel))} · ${amount.missing && amount.missing < rows.length ? '已知 ' : ''}${totalValue(amount, rows)}</p>
      ${rows.length ? `<ul class="management-list">${rows.map(render).join('')}</ul>` : empty('当前范围暂无记录')}
    </div>
    <footer class="dialog-footer"><button type="button" class="btn secondary" data-action="close">关闭</button></footer>`;
}

export function analyticsContractCashDetail(S, P, data, id) {
  if (typeof id !== 'string') return '';
  const category = categories.find(([key]) => id === 'contract-category-' + key);
  const labels = receiptLabels(P);
  const receiptId = id.startsWith('cash-') ? id.slice(5) : '';
  if (!category && id !== 'contract-margin' && !Object.hasOwn(labels, receiptId)) return '';
  const {report, contractGroups, receiptGroups} = contractCashData(S, P, data);
  if (report.invalid) return '';
  if (category) {
    const [key, label] = category;
    return drawer(S, P, report, label + '合同明细', contractGroups.get(key), valueOf, '份合同', '金额待核对', row => signedRow(S, row, false));
  }
  if (id === 'contract-margin') {
    return drawer(S, P, report, '扣费后毛利明细', report.signed, marginOf, '份合同', '毛利待核对', row => signedRow(S, row, true));
  }
  return drawer(S, P, report, labels[receiptId], receiptGroups[receiptId], receiptAmount, '笔到账', '金额待核对', row => receiptRow(S, row));
}
