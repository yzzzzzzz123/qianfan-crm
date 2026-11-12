import { badge, customerName, dateLabel, empty, esc, icon, money, plainMoney, salesName, sectionHead, userName } from '../ui.js';
import { analyticsManagementModel } from './management-analytics-model.js';
import { financeAmount } from './management-finance.js';
import { analyticsContractCash, analyticsContractCashDetail } from './analytics-contract-cash.js';
import { analyticsDecisions } from './analytics-decisions.js';

const prefixes = { 'this-month': '本月', 'last-month': '上月', 'this-quarter': '本季度', custom: '区间' };
const selectedPreset = P => P.from || P.to ? 'custom' : P.managementPreset || 'this-month';
const rangeLabel = range => `${range.from || '最早记录'} 至 ${range.to || '最新记录'}`;
const valueOf = row => row.amount;
const scopeLabel = (S, P, report) => [
  report.owner ? userName(S, report.owner) : '全部负责人',
  P.level && `${P.level} 级客户`,
  P.saleType,
].filter(Boolean).join(' · ');

function options(values, selected) {
  return values.map(([value, text]) => `<option value="${esc(value)}"${String(value) === String(selected || '') ? ' selected' : ''}>${esc(text)}</option>`).join('');
}

function toolbar(S, P, report) {
  const preset = selectedPreset(P);
  const scopedOwners = new Set([...(S.opportunities || []), ...(S.contracts || [])].map(row => Number(row.owner_id)));
  const people = (S.users || []).filter(u => ['admin', 'sales'].includes(u.role) && (u.active || scopedOwners.has(Number(u.id))));
  const types = ['新签自建', '新签分发', '续费', '增购'];
  const open = P.analyticsFiltersOpen ?? preset === 'custom';
  return `<details class="panel analytics-filters"${open ? ' open' : ''}>
    <summary><span><strong>${esc(scopeLabel(S, P, report))}</strong> · 合同与到账 ${preset === 'custom' ? '自定义' : prefixes[preset]}</span><span>${icon('opportunities')}筛选</span></summary>
    <div class="analytics-filter-body">
      <div class="management-filter-row">
        <div class="management-presets" role="group" aria-label="经营区间">${Object.entries(prefixes).map(([id, text]) =>
          `<button type="button" class="btn ${preset === id ? 'secondary active' : 'ghost'}" data-action="management-range" data-id="${id}" aria-pressed="${preset === id}">${id === 'custom' ? '自定义' : text}</button>`).join('')}</div>
        <label>起始日期<input id="filter-from" type="date" aria-label="起始日期" value="${esc(report.range.from)}"></label>
        <label>结束日期<input id="filter-to" type="date" aria-label="结束日期" value="${esc(report.range.to)}"></label>
      </div>
      <div class="management-filter-row">
        <label>负责人<select id="filter-owner" aria-label="负责人">${options([['', '全部负责人'], ...people.map(u => [u.id, u.name])], report.owner)}</select></label>
        <label>客户等级<select id="filter-level" aria-label="客户等级">${options([['', '全部等级'], ...(S.rules?.customer_levels || ['A', 'B', 'C']).map(v => [v, v])], P.level)}</select></label>
        <label>销售类型<select id="filter-sale-type" aria-label="销售类型">${options([['', '全部类型'], ...types.map(v => [v, v])], P.saleType)}</select></label>
        <button type="button" class="btn ghost" data-action="reset-filters">${icon('refresh')}重置</button>
      </div>
    </div>
  </details>`;
}

function knownText(amount, count, compact = false) {
  if (count > 0 && amount.missing === count) return '待核对';
  return compact ? money(amount.total, true) : plainMoney(amount.total);
}

const metricAmount = (rows, get = valueOf) => knownText(financeAmount(rows, get), rows.length, true);
const fullAmount = (rows, get = valueOf) => knownText(financeAmount(rows, get), rows.length);
const missingNote = (rows, get = valueOf) => {
  const {missing} = financeAmount(rows, get);
  return missing ? ` · ${missing} 项金额待核对` : '';
};
const reviewNote = rows => {
  const count = rows.filter(row => row.needsReview).length;
  return count ? ` · ${count} 笔计划待核对` : '';
};

function metric(id, label, value, note, symbol, tone = '') {
  return `<button type="button" class="management-metric analytics-metric" data-action="management-analytics-detail" data-id="${id}"${tone ? ` data-tone="${tone}"` : ''}>
    <span class="management-metric-label">${label}${icon(symbol)}</span>
    <strong class="management-metric-value">${value}</strong>
    <span class="management-metric-note">${esc(note)}</span>
  </button>`;
}

function cashMetrics(S, P, {report, cash}) {
  const prefix = prefixes[selectedPreset(P)];
  const receiptAmount = row => row.payment.amount;
  return `<section class="management-section analytics-section">
    ${sectionHead('回款风险', `风险截至 ${S.today} · 按未核销计划及待安排余额统计`)}
    <div class="management-metrics analytics-metrics${report.invalid ? ' management-three' : ''}">
      ${metric('overdue', '已逾期未收', metricAmount(cash.overdue), `${cash.overdue.length} 笔计划 · 含跨月逾期${reviewNote(cash.overdue)}`, 'alert', cash.overdue.length ? 'risk' : '')}
      ${metric('upcoming', '未来 7 天到期', metricAmount(cash.upcoming), `${cash.upcoming.length} 笔计划 · 含今天${reviewNote(cash.upcoming)}`, 'clock')}
      ${metric('unplanned', '未安排收款计划', metricAmount(cash.unplanned), `${cash.unplanned.length} 份合同 · 待安排余额${missingNote(cash.unplanned)}`, 'contracts')}
      ${report.invalid ? '' : metric('receipts', prefix + '实际到账', metricAmount(report.receipts, receiptAmount), `${report.receipts.length} 笔到账 · 按实际到账日${missingNote(report.receipts, receiptAmount)}`, 'wallet')}
    </div>
  </section>`;
}

const detailsButton = (id, label) => `<button type="button" class="text-link" data-action="management-analytics-detail" data-id="${id}">${esc(label)} ${icon('arrow')}</button>`;
const recordButton = (action, row, name) => `<button type="button" class="text-link" data-action="${action}" data-id="${esc(row.id)}">${esc(name)}</button>`;
const recordCustomer = (S, row) => row.customer_name || customerName(S, row.customer_id);
const rowMoney = value => typeof value === 'number' && Number.isFinite(value) ? plainMoney(value) : '金额待核对';
const displayDate = date => date ? dateLabel(date) : '待补';

function opportunityRow(S, row) {
  const {opportunity, date, amount, reasons, nextAction, level} = row;
  const context = [recordCustomer(S, opportunity), salesName(S, opportunity), `预计签约 ${displayDate(date)}`].join(' · ');
  return `<li class="management-list-row analytics-list-row" data-opportunity-id="${esc(opportunity.id)}">
    <div><div class="analytics-row-title">${recordButton('opportunity', opportunity, opportunity.name || '商机详情')}${badge(opportunity.stage, 'blue')}</div>
      <small>${esc(context)}</small>
      ${reasons.length ? `<p class="analytics-reason" data-level="${esc(level)}">${esc(reasons.join(' · '))}</p>` : ''}
      ${row.signedAmount > 0 ? `<small>原预计 ${rowMoney(row.originalAmount)} · 已签 ${rowMoney(row.signedAmount)}</small>` : ''}
      <small>下一步 ${esc(nextAction || '待安排')}</small>
    </div><strong>${rowMoney(amount)}</strong>
  </li>`;
}

const interventionColumns = ['商机 / 客户', '负责人', '预计签约日', '预计签约额', '卡点与下一步'];
const collectionColumns = ['合同 / 客户', '负责人', '预计收款日', '待处理金额', '催收事项'];

function actionTable(rows, columns, render, emptyTitle) {
  if (!rows.length) return empty(emptyTitle);
  return `<div class="analytics-action-table-body">
    <div class="analytics-action-table-columns" aria-hidden="true">${columns.map(label => `<span>${label}</span>`).join('')}</div>
    <ul class="analytics-action-table-list">${rows.slice(0, 5).map(render).join('')}</ul>
  </div>`;
}

function interventionRow(S, row) {
  const {opportunity, date, amount, level, nextAction} = row;
  const overdue = opportunity.risk?.overdue;
  const reasons = row.reasons.map(reason => reason === '跟进逾期' && overdue > 0 ? `跟进已逾期 ${overdue} 天` : reason);
  return `<li class="analytics-action-table-row" data-opportunity-id="${esc(opportunity.id)}">
    <div class="analytics-action-table-name">
      ${recordButton('opportunity', opportunity, opportunity.name || '商机详情')}
      <div>${esc(recordCustomer(S, opportunity))} ${badge(opportunity.stage, 'blue')}</div>
    </div>
    <div class="analytics-action-table-fact"><span>${interventionColumns[1]}</span>${esc(salesName(S, opportunity))}</div>
    <div class="analytics-action-table-fact"><span>${interventionColumns[2]}</span>
      ${date ? `<time datetime="${esc(date)}">${esc(displayDate(date))}</time>` : '待补'}
    </div>
    <div class="analytics-action-table-fact analytics-action-table-amount">
      <span>${interventionColumns[3]}</span><strong>${rowMoney(amount)}</strong>
      ${row.signedAmount > 0 ? `<small>原预计 ${rowMoney(row.originalAmount)} · 已签 ${rowMoney(row.signedAmount)}</small>` : ''}
    </div>
    <div class="analytics-action-table-action">
      <p class="analytics-reason" data-level="${esc(level)}">${esc(reasons.join(' · '))}</p>
      <p><span>下一步</span> ${esc(nextAction || '待安排')}</p>
    </div>
  </li>`;
}

function interventionPanel(S, rows) {
  const summary = financeAmount(rows, valueOf);
  const caption = [
    `${rows.length} 条商机`,
    rows.length > summary.missing && `${summary.missing ? '已知' : ''}预计签约额 ${plainMoney(summary.total)}`,
    summary.missing && `${summary.missing} 条金额待核对`,
  ].filter(Boolean).join(' · ');
  return `<section class="panel analytics-interventions analytics-action-table" aria-label="需要介入的商机">
    ${sectionHead('需要介入的商机', caption,
      rows.length > 5 ? detailsButton('interventions', '查看全部') : '')}
    ${actionTable(rows, interventionColumns, row => interventionRow(S, row), '当前范围暂无需要介入的商机')}
  </section>`;
}

const cashTags = { overdue: ['已逾期', 'danger'], upcoming: ['7 天内到期', 'warning'], undated: ['待补日期', 'neutral'], unplanned: ['待补计划', 'neutral'] };

function collectionPriorityRow(S, row) {
  const {contract, plan, kind, date, amount, reason} = row;
  const [text, tone] = cashTags[kind];
  const dateText = date ? `<time datetime="${esc(date)}">${esc(displayDate(date))}</time>` : kind === 'unplanned' ? '待安排' : '待补';
  const level = kind === 'overdue' ? 'critical' : kind === 'upcoming' ? 'warning' : '';
  return `<li class="analytics-action-table-row" data-cash-kind="${kind}" data-collection-id="${esc(contract.id)}">
    <div class="analytics-action-table-name">
      ${recordButton('collection', contract, contract.name || contract.contract_no || '合同回款')}
      <div>${esc(recordCustomer(S, contract))} ${badge(text, tone)}</div>
    </div>
    <div class="analytics-action-table-fact"><span>${collectionColumns[1]}</span>${esc(salesName(S, contract))}</div>
    <div class="analytics-action-table-fact"><span>${collectionColumns[2]}</span>${dateText}</div>
    <div class="analytics-action-table-fact analytics-action-table-amount">
      <span>${collectionColumns[3]}</span><strong>${rowMoney(amount)}</strong>
      <small>${kind === 'unplanned' ? '待安排余额' : '计划未核销余款'}</small>
    </div>
    <div class="analytics-action-table-action">
      <p${level ? ` class="analytics-reason" data-level="${level}"` : ''}>${esc(reason)}</p>
      ${plan?.id ? `<p><span>收款计划 #${esc(plan.id)}</span></p>` : ''}
    </div>
  </li>`;
}

function collectionRow(S, row) {
  const {contract, plan, kind, date, amount, reason} = row;
  const [text, tone] = cashTags[kind];
  const context = [recordCustomer(S, contract), salesName(S, contract), date && `应收 ${displayDate(date)}`, plan?.id && `计划 #${plan.id}`].filter(Boolean).join(' · ');
  return `<li class="management-list-row analytics-list-row" data-cash-kind="${kind}" data-collection-id="${esc(contract.id)}">
    <div><div class="analytics-row-title">${recordButton('collection', contract, contract.name || contract.contract_no || '合同回款')}${badge(text, tone)}</div>
      <small>${esc(context)}</small>
      <p class="analytics-reason">${esc(reason)}</p>
    </div><strong>${rowMoney(amount)}</strong>
  </li>`;
}

function signedRow(S, id, row) {
  const receipt = id === 'receipts';
  const record = receipt ? row.contract : row;
  const amount = receipt ? row.payment.amount : record.amount;
  const date = receipt ? row.payment.pay_date : record.sign_date;
  const reference = receipt && row.payment.id ? `到账 #${row.payment.id}` : '';
  return `<li class="management-list-row analytics-list-row"><div>
    ${recordButton(receipt ? 'collection' : 'contract', record, record.name || record.contract_no || recordCustomer(S, record))}
    <small>${esc([recordCustomer(S, record), salesName(S, record), displayDate(date), reference].filter(Boolean).join(' · '))}</small>
    </div><strong>${rowMoney(amount)}</strong></li>`;
}

const list = (rows, render) => rows.length
  ? `<ul class="management-list">${rows.map(render).join('')}</ul>`
  : empty('当前范围暂无记录');

const periodNames = { monthly: '当月', quarterly: '本季度' };

function targetStatus(pipeline) {
  if (!pipeline.comparable) return '目标按负责人统计 · 清除客户等级或销售类型筛选后查看缺口';
  if (!pipeline.members.length) return '当前范围没有适用的销售目标';
  return `${pipeline.configured}/${pipeline.members.length} 位销售已设目标`;
}

function periodValue(period, key) {
  if (key === 'signed') {
    return period.target == null ? '—' : knownText(period.signed, period.signedRows.length, true);
  }
  const value = period[key];
  if (value != null) return key === 'gap' && value === 0 ? '已达成' : money(value, true);
  return key === 'gap' && period.signed.missing && period.target != null ? '待核对' : '—';
}

function summaryButton(id, label, value, className = '') {
  return `<button type="button" class="analytics-summary-button ${className}" data-action="management-analytics-detail" data-id="${id}">
    <span>${esc(label)}</span><strong>${value}</strong>${icon('chevron')}
  </button>`;
}

function targetTile(pipeline, key) {
  const period = pipeline[key];
  const month = key === 'monthly';
  const name = periodNames[key];
  const percent = period.target > 0 && !period.signed.missing ? Math.round(period.signed.total / period.target * 1000) / 10 : null;
  const reserve = month ? [
    ['month-expected', '本月预计签约', period.expected], ['monthly-commercial', '其中商务商机', period.commercial.all],
  ] : [
    ['quarter-expected', '本季度剩余预计', period.expected], ['quarter-later', '其中后续月份', pipeline.laterExpected],
  ];
  return `<article class="panel analytics-target">
    <header><h3>${name}签约</h3><time>${esc(month ? pipeline.month : pipeline.quarter)}</time></header>
    ${summaryButton(key + '-gap', '目标缺口', periodValue(period, 'gap'), 'analytics-gap')}
    <div class="analytics-target-values">
      ${summaryButton(key + '-target', '签约目标', periodValue(period, 'target'))}
      ${summaryButton(key + '-signed', '目标范围已签', periodValue(period, 'signed'))}
    </div>
    ${percent == null ? '' : `<div class="analytics-target-progress"><progress max="100" value="${Math.min(100, Math.max(0, percent))}" aria-label="${name}目标达成率"></progress><span>${percent}%</span></div>`}
    ${reserve.map(([id,label,rows]) => summaryButton(id,label,opportunityAmount(rows),'analytics-target-reserve')).join('')}
  </article>`;
}

function scenarioLabel(value) {
  return value === null ? '—' : value === 0 ? '可覆盖缺口' : '仍差 ' + money(value, true);
}

function targetsPanel(S, pipeline) {
  const {monthly, quarterly} = pipeline;
  return `<section class="management-section analytics-section" aria-label="月度和季度目标">
    ${sectionHead('签约目标缺口', `截至 ${S.today} · ${targetStatus(pipeline)} · 商机金额按当前业务范围`)}
    <div class="analytics-target-grid">${targetTile(pipeline, 'monthly')}${targetTile(pipeline, 'quarterly')}</div>
    <div class="panel analytics-scenarios">
      <div><h3>本月商务覆盖测算</h3><p>按已设目标销售的预计签约测算</p></div>
      ${summaryButton('scenario-ready', '推进条件明确的商务都签下', scenarioLabel(monthly.coverage.afterReady))}
      ${summaryButton('scenario-all', '本月全部商务都签下', scenarioLabel(monthly.coverage.afterAll))}
      ${detailsButton('all-signed', '核对全部签约')}
    </div>
  </section>`;
}

function decisionPanel(decisions) {
  if (!decisions.length) return '';
  return `<section class="management-section analytics-section">
    ${sectionHead('优先决策建议', '')}
    <div class="analytics-decisions">
      ${decisions.map(item => `<article class="panel analytics-decision">
        <h3>${esc(item.title)}</h3><p>${esc(item.evidence)}</p>
        <p class="analytics-decision-action">${esc(item.nextAction)}</p>
        ${item.owners.length || item.due ? `<small>${esc([item.owners.join('、'), item.due].filter(Boolean).join(' · '))}</small>` : ''}
        ${detailsButton(item.drawerId, '查看依据')}
      </article>`).join('')}
    </div>
  </section>`;
}

const stageFields = [
  ['active', '当前在途'], ['created', '本月新增'], ['monthly', '本月预计'],
  ['later', '季度后续'], ['undated', '签约日待补'], ['overdue', '超期需处理'],
];

function opportunityAmount(rows) {
  return `${metricAmount(rows)}<small class="analytics-value-note">${rows.length} 条${missingNote(rows)}</small>`;
}

function stageRow(stage, index) {
  return `<article class="analytics-stage">
    <div><h3>${esc(stage.stage)}</h3>${stage.averageAge == null ? '' : `<small>平均停留 ${stage.averageAge} 天</small>`}</div>
    <div class="analytics-stage-fields">${stageFields.map(([id, label]) => {
      const rows = stage[id];
      return summaryButton(`stage-${index}-${id}`, label,
        ['created','overdue'].includes(id) ? `${rows.length}<small> 条</small>` : opportunityAmount(rows));
    }).join('')}</div>
  </article>`;
}

function opportunityPanels(S, data) {
  const {pipeline, interventions} = data;
  const groups = [
    ['monthly-commercial-ready', '本月推进条件明确', pipeline.monthly.commercial.ready],
    ['monthly-commercial-risk', '本月商务需介入', pipeline.monthly.commercial.atRisk],
    ['quarter-later-commercial', '季度后续商务', pipeline.laterExpected.filter(row => row.opportunity.stage === '商务')],
    ['undated-commercial', '商务签约日待补', pipeline.undatedCommercial],
  ];
  return `<section class="panel analytics-stage-panel">
    ${sectionHead('商机分阶段', '按当前在途商机统计，本月新增按建档日期，超期含阶段停留、跟进或预计签约超期',
      detailsButton('month-expected', '查看本月预计签约'))}
    ${pipeline.stages.length ? `<div class="analytics-stage-list">${pipeline.stages.map(stageRow).join('')}</div>` : empty('当前范围暂无商机')}
  </section>
  <div class="management-columns analytics-action-lists">
    <section class="panel analytics-actions">
      ${sectionHead('商务商机', '')}
      <div class="analytics-compact-list">${groups.map(([id,label,rows]) =>
        summaryButton(id,label,opportunityAmount(rows))).join('')}</div>
    </section>
    <section class="panel analytics-actions">
      ${sectionHead('季度逐月签约', '已签按签约日，预计按商机预计签约日')}
      <div class="analytics-compact-list">${pipeline.quarterMonths.map(row =>
        summaryButton('quarter-month-' + row.month, row.month,
          `已签 ${knownText(row.signed, row.signedRows.length, true)}${row.month < pipeline.month ? '' : `<small class="analytics-value-note">预计 ${fullAmount(row.expected)}${missingNote(row.expected)}</small>`}`)).join('')}</div>
    </section>
  </div>
  ${interventionPanel(S, interventions)}`;
}

function collectionPanel(S, cash) {
  const undated = cash.priority.filter(row => row.kind === 'undated').length;
  const caption = [`${cash.priority.length} 项`,
    cash.overdue.length && `逾期 ${cash.overdue.length} 笔`,
    cash.upcoming.length && `7 天内到期 ${cash.upcoming.length} 笔`,
    undated && `待补收款日 ${undated} 笔`,
    cash.unplanned.length && `待安排计划 ${cash.unplanned.length} 份合同`,
  ].filter(Boolean).join(' · ');
  return `<section class="panel analytics-collections analytics-action-table" aria-label="优先催收清单">
    ${sectionHead('优先催收清单', caption, cash.priority.length > 5 ? detailsButton('priority', '查看全部') : '')}
    ${actionTable(cash.priority, collectionColumns, row => collectionPriorityRow(S, row), '当前范围暂无优先催收事项')}
  </section>`;
}

export function analyticsPage(S, P = {}) {
  const data = analyticsManagementModel(S, P);
  const control = toolbar(S, P, data.report);
  const periodError = data.report.invalid ? '<p class="form-error" role="alert">合同与到账的起始日期不能晚于结束日期。</p>' : '';
  return `<link rel="stylesheet" href="./modules/management-analytics.css">${control}${periodError}
    ${targetsPanel(S, data.pipeline)}${decisionPanel(analyticsDecisions(S, data))}${opportunityPanels(S, data)}
    ${analyticsContractCash(S, P, data)}${cashMetrics(S, P, data)}${collectionPanel(S, data.cash)}`;
}

function drawer(S, P, report, title, period, body) {
  return `<header class="dialog-head"><div><h2>${esc(title)}</h2><p>${esc(scopeLabel(S, P, report))} · ${esc(period)}</p></div>
      <button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header>
    <div class="dialog-body management-detail analytics-detail">${body}</div>
    <footer class="dialog-footer"><button type="button" class="btn secondary" data-action="close">关闭</button></footer>`;
}

function detailTotal(rows, unit, amount = valueOf) {
  return `<p class="management-detail-total">${rows.length} ${unit} · ${fullAmount(rows, amount)}${missingNote(rows, amount)}</p>`;
}

function opportunityList(S, rows) {
  return detailTotal(rows, '个商机') + list(rows, row => opportunityRow(S, row));
}

function targetDetail(S, P, data, key, kind) {
  const {report, pipeline} = data;
  const period = pipeline[key], title = periodNames[key] + {target:'签约目标',signed:'目标范围已签',gap:'签约目标缺口'}[kind];
  const amountKey = key === 'monthly' ? 'monthlyAmount' : 'quarterAmount';
  const memberRows = pipeline.members.map(row => ({member:row.member, amount:row[amountKey]}));
  const targetInfo = `<p class="management-detail-total">${esc(targetStatus(pipeline))}${period.target == null ? '' : ' · 目标 ' + plainMoney(period.target)}</p>`;
  const progress = period.target == null ? '' : `<p class="analytics-detail-note">目标范围已签 ${knownText(period.signed, period.signedRows.length)}${missingNote(period.signedRows)} · 缺口 ${period.gap == null ? '待核对' : plainMoney(period.gap)}</p>`;
  const memberList = list(memberRows, ({member, amount}) => `<li class="management-list-row"><strong>${esc(member.name)}</strong><strong>${amount == null ? '待设置' : plainMoney(amount)}</strong></li>`);
  const signed = detailTotal(period.signedRows,'份合同') + list(period.signedRows,row=>signedRow(S,'signed',row));
  const body = kind === 'target' ? targetInfo + memberList
    : targetInfo + progress + (period.target == null ? '' : signed);
  return drawer(S, P, report, title, rangeLabel(period.range), body);
}

function opportunityDetails(S, P, data, id) {
  const {pipeline, report, interventions} = data;
  const {monthly, laterExpected, undatedCommercial} = pipeline;
  const groups = {
    'monthly-commercial': ['本月商务商机', monthly.commercial.all],
    'monthly-commercial-ready': ['本月推进条件明确的商务商机', monthly.commercial.ready],
    'monthly-commercial-risk': ['本月商务需介入', monthly.commercial.atRisk],
    'quarter-later': ['季度后续预计签约', laterExpected],
    'quarter-expected': ['本季度剩余预计签约', pipeline.quarterly.expected],
    'quarter-later-commercial': ['季度后续商务商机', laterExpected.filter(row => row.opportunity.stage === '商务')],
    'undated-commercial': ['商务签约日待补', undatedCommercial],
    'month-expected': ['本月预计签约', monthly.expected],
    interventions: ['需要介入的商机', interventions],
  };
  if (Object.hasOwn(groups,id)) {
    const [title, rows] = groups[id];
    return drawer(S, P, report, title, `截至 ${S.today}`, opportunityList(S, rows));
  }
  if (id === 'scenario-ready' || id === 'scenario-all') {
    const ready = id === 'scenario-ready', rows = ready ? monthly.coverage.ready : monthly.coverage.all;
    const value = ready ? monthly.coverage.afterReady : monthly.coverage.afterAll;
    const result = monthly.target == null ? targetStatus(pipeline)
      : value === null ? '缺口或商机金额待核对' : value === 0 ? '条件成立时可覆盖缺口' : '条件成立后仍差 ' + plainMoney(value);
    const body = `<p class="management-detail-total">${result}</p>` + opportunityList(S, rows);
    return drawer(S, P, report, ready ? '明确商务都签下的测算' : '全部商务都签下的测算', pipeline.month, body);
  }
  const stageMatch = /^stage-(\d+)-(active|created|monthly|later|undated|overdue)$/.exec(id);
  if (stageMatch) {
    const stage = pipeline.stages[Number(stageMatch[1])], key = stageMatch[2];
    if (!stage) return '';
    const title = stage.stage + ' · ' + stageFields.find(([field]) => field === key)[1];
    return drawer(S, P, report, title, `截至 ${S.today}`, opportunityList(S, stage[key]));
  }
  const quarterMonth = pipeline.quarterMonths.find(row => id === 'quarter-month-' + row.month);
  if (!quarterMonth) return '';
  return drawer(S, P, report, quarterMonth.month + ' 签约与预计', quarterMonth.month,
    `<h3 class="analytics-detail-group">已签合同</h3>${detailTotal(quarterMonth.signedRows,'份合同')}${list(quarterMonth.signedRows,row=>signedRow(S,'signed',row))}
      ${quarterMonth.month < pipeline.month ? '' : `<h3 class="analytics-detail-group">预计签约商机</h3>${opportunityList(S,quarterMonth.expected)}`}`);
}

export function analyticsDetail(S, P, id) {
  const data = analyticsManagementModel(S, P);
  const {report, pipeline, cash} = data;
  const target = /^(monthly|quarterly)-(target|signed|gap)$/.exec(id);
  if (target) return targetDetail(S, P, data, target[1], target[2]);
  if (id === 'all-signed') {
    const body = [['当月', pipeline.monthly], ['本季度', pipeline.quarterly]].map(([title, period]) =>
      `<h3 class="analytics-detail-group">${title}</h3>${detailTotal(period.allSignedRows,'份合同')}${list(period.allSignedRows,row=>signedRow(S,'signed',row))}`).join('');
    return drawer(S, P, report, '全部签约金额', `截至 ${S.today}`, body);
  }
  if (id?.startsWith('decision-')) {
    const decision = analyticsDecisions(S, data).find(row => row.drawerId === id);
    if (!decision) return '';
    const records = decision.records || [];
    const body = `<p class="management-detail-total">${esc(decision.evidence)}</p><p class="analytics-detail-note">${esc(decision.nextAction)}</p>`
      + (records.length ? list(records, row => row.opportunity ? opportunityRow(S, row)
        : row.kind === 'signed' ? signedRow(S, 'signed', row.contract) : collectionRow(S, row)) : '');
    return drawer(S, P, report, decision.title, `截至 ${S.today}`, body);
  }
  const opportunity = opportunityDetails(S, P, data, id);
  if (opportunity) return opportunity;
  if (id === 'receipts') {
    if (report.invalid) return '';
    return drawer(S, P, report, prefixes[selectedPreset(P)] + '实际到账', rangeLabel(report.range) + ' · 按实际到账日',
      detailTotal(report.receipts, '笔到账', row => row.payment.amount) + list(report.receipts, row => signedRow(S, id, row)));
  }
  const cashTitles = { overdue: '已逾期未收', upcoming: '未来 7 天到期', unplanned: '未安排收款计划', priority: '优先催收清单' };
  if (!Object.hasOwn(cashTitles, id)) return analyticsContractCashDetail(S, P, data, id);
  const period = id === 'upcoming' ? `${S.today} 至 ${cash.upcomingThrough}` : `截至 ${S.today}`;
  const body = id === 'priority' ? `<p class="management-detail-total">${cash.priority.length} 项待处理</p>`
    : detailTotal(cash[id], id === 'unplanned' ? '份合同' : '笔计划');
  return drawer(S, P, report, cashTitles[id], period, body + list(cash[id], row => collectionRow(S, row)));
}
