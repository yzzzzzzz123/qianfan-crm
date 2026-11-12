import { empty, esc, icon } from '../ui.js';
import { ownerOptions } from './shared.js';

const saleTypes = ['新签自建', '新签分发', '续费', '增购'];

function selectFilter(id, label, options, value) {
  return `<select id="${id}" aria-label="${label}"><option value="">${label}</option>${options.map(option =>
    `<option value="${esc(option)}"${option === value ? ' selected' : ''}>${esc(option)}</option>`).join('')}</select>`;
}

export function segmentFilters(S, P, includeCohort = false) {
  return `<div class="filterbar management-segment-filters">
    ${S.actor.role === 'admin' ? ownerOptions({ ...S, users: S.users || [] }, String(P.owner || '')) : ''}
    ${selectFilter('filter-level', '全部客户等级', S.rules?.customer_levels || ['A', 'B', 'C'], P.level)}
    ${includeCohort ? selectFilter('filter-sale-type', '全部销售类型', saleTypes, P.saleType) : ''}
    ${includeCohort ? `<fieldset><legend>商机创建日期</legend>
      <input id="filter-from" type="date" aria-label="商机创建起始日期" value="${esc(P.from)}">
      <span aria-hidden="true">至</span>
      <input id="filter-to" type="date" aria-label="商机创建结束日期" value="${esc(P.to)}">
    </fieldset>` : ''}
    <button type="button" class="btn ghost" data-action="reset-filters">${icon('refresh')}重置</button>
  </div>`;
}

export function segmentCards(action, cards) {
  return `<section class="metrics">${cards.map(({id, title, value, note, symbol}) =>
    `<button type="button" class="metric" data-action="${action}" data-id="${esc(id)}">
      <span class="metric-label">${esc(title)}${icon(symbol)}</span>
      <strong class="metric-value">${value}</strong>
      <span class="management-metric-note">${esc(note)}</span>
    </button>`).join('')}</section>`;
}

export function segmentDrawer(title, note, rows) {
  return `<header class="dialog-head"><div><h2>${esc(title)}</h2><p>${esc(note)}</p></div>
    <button type="button" class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header>
    <div class="dialog-body management-segment-detail">${rows || empty('暂无对应记录')}</div>
    <footer class="dialog-footer"><button type="button" class="btn secondary" data-action="close">关闭</button></footer>`;
}

export function segmentList(rows, renderRow) {
  return rows.length ? `<ul class="management-segment-list">${rows.map(renderRow).join('')}</ul>` : '';
}
