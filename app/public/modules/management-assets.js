import { badge, empty, esc, icon, salesName, sectionHead } from '../ui.js';
import { businessDate } from './management-finance.js';
import { segmentCards, segmentDrawer, segmentFilters, segmentList } from './management-segments.js';

const action = 'management-asset-detail';
const renewalWindow = 30;
const dimensions = [['manual_level', '客户分级'], ['industry', '行业结构'], ['region', '区域结构'], ['group_name', '集团关系']];
const management = c => c.management_status || (['冻结', '流失'].includes(c.status) ? c.status : '正常');
const relationship = c => c.relationship_status || '待核对';
const ownerMissing = c => c.owner_id == null || c.owner_id === '';
const daysBetween = (first, last) => Math.round((Date.parse(last) - Date.parse(first)) / 86400000);

function renewalContracts(S, scope) {
  const grouped = new Map();
  const ids = new Set(scope.map(c => Number(c.id)));
  for (const contract of S.contracts || []) {
    const id = Number(contract.customer_id);
    if (!ids.has(id) || contract.retired_at || contract.terminated_at || contract.lifecycle === '草稿') continue;
    if (S.actor.role === 'sales' && Number(contract.owner_id) !== Number(S.actor.id)) continue;
    const due = businessDate(contract.valid_until);
    const signed = businessDate(contract.sign_date);
    if (!due || !signed || signed > S.today || due < S.today || daysBetween(S.today, due) > renewalWindow) continue;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push({...contract, due});
  }
  for (const rows of grouped.values()) rows.sort((a, b) => a.due.localeCompare(b.due));
  return grouped;
}

export function scopedAssetCustomers(S, P = {}) {
  const owner = S.actor.role === 'sales' ? S.actor.id : P.owner;
  return (S.customers || []).filter(c => !c.shared && (!P.level || c.manual_level === P.level) &&
    (!owner || Number(c.owner_id) === Number(owner) ||
      ownerMissing(c) && c.collaborators?.some(id => Number(id) === Number(owner))));
}

function model(S, P) {
  const scope = scopedAssetCustomers(S, P);
  const dueContracts = renewalContracts(S, scope);
  const inactivityDays = Number(S.rules?.inactivity_days) > 0 ? Number(S.rules.inactivity_days) : 30;
  const withDates = scope.map(customer => {
    const id = Number(customer.id);
    const last = businessDate(customer.last_interaction);
    const created = businessDate(customer.created_at);
    const since = last || created;
    const days = since ? daysBetween(since, S.today) : null;
    return { customer, last, days, contracts: dueContracts.get(id) || [] };
  });
  const cards = [
    {id:'cooperating', title:'已合作客户', note:'有有效签约记录', symbol:'contracts',
      rows:withDates.filter(({customer}) => relationship(customer) === '已合作')},
    {id:'stale', title:'A/B 级久未跟进', note:`正常客户达到 ${inactivityDays} 天`, symbol:'clock',
      rows:withDates.filter(({customer, days}) => ['A', 'B'].includes(customer.manual_level) && management(customer) === '正常' && days !== null && days >= inactivityDays).sort((a, b) => b.days - a.days)},
    {id:'renewal', title:'合同临近到期', note:`${renewalWindow} 天内有合同到期 · 按客户去重`, symbol:'alert',
      rows:withDates.filter(({contracts}) => contracts.length).sort((a, b) => a.contracts[0].due.localeCompare(b.contracts[0].due))},
    {id:'unassigned', title:'未分配负责人', note:'客户档案尚未指定负责人', symbol:'customers',
      rows:withDates.filter(({customer}) => ownerMissing(customer))},
  ];
  const breakdown = dimensions.map(([key, title]) => {
    const groups = new Map();
    for (const row of withDates) {
      const name = String(row.customer[key] || '').trim() || '未填写';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(row);
    }
    const entries = [...groups].map(([name, rows]) => ({name, rows})).sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name, 'zh-CN'));
    return {key, title, entries};
  });
  return {all:withDates, cards, breakdown, inactivityDays};
}

function customerRow(S, row, showContracts = false) {
  const c = row.customer;
  const caption = [salesName(S, c), c.manual_level ? `${c.manual_level} 级` : '等级待标注', c.industry, c.region].filter(Boolean).join(' · ');
  const group = [c.parent_company, c.group_name].filter(Boolean).join(' / ');
  const contracts = showContracts && row.contracts.length
    ? `<ul class="management-renewals">${row.contracts.map(contract =>
      `<li><button type="button" class="text-link" data-action="contract" data-id="${esc(contract.id)}">${esc(contract.contract_no || contract.name || '合同')}</button>
        <time datetime="${esc(contract.due)}">${esc(contract.due)} 到期</time></li>`).join('')}</ul>`
    : '';
  return `<li class="management-customer-row">
    <div class="management-customer-content"><div>
      <button type="button" class="text-link" data-action="customer" data-id="${esc(c.id)}">${esc(c.short_name || c.name)}</button>
      <p>${esc(caption)}</p>
      ${group ? `<p>${esc(group)}</p>` : ''}
      <small>${row.last ? `最近跟进 ${esc(row.last)}` : '暂无跟进记录'}</small>
    </div>
    <div class="management-customer-status">${badge(relationship(c), relationship(c) === '已合作' ? 'success' : 'blue')}${badge(management(c), management(c) === '正常' ? 'neutral' : 'warning')}</div></div>
    ${contracts}
  </li>`;
}

function distribution(data) {
  return data.breakdown.map(({key, title, entries}) => `<details class="management-structure">
    <summary>${esc(title)} <span>${entries.length} 组</span></summary>
    ${entries.length ? `<ul>${entries.map(({name, rows}, index) => `<li>
      <button type="button" class="text-link" data-action="${action}" data-id="group-${key}-${index}">${esc(name)} <b>${rows.length} 家</b></button>
    </li>`).join('')}</ul>` : '<p>暂无分布记录</p>'}
  </details>`).join('');
}

export function assetPage(S, P = {}) {
  const data = model(S, P);
  const cards = data.cards.map(card => ({...card, value:`${card.rows.length}<small>家</small>`}));
  const sorted = [...data.all].sort((a, b) => b.last.localeCompare(a.last) || (a.customer.name || '').localeCompare(b.customer.name || '', 'zh-CN'));
  return `<link rel="stylesheet" href="./modules/management-segments.css"><div class="management-segments">
    ${segmentFilters(S, P)}
    <p class="management-segment-context">截至 ${esc(S.today)} · 当前范围 ${data.all.length} 家客户。客户可同时属于多个清单。</p>
    ${segmentCards(action, cards)}
    <section class="panel">
      ${sectionHead('客户互动与集团档案', '按最近有效跟进排列', `<button type="button" class="text-link" data-action="${action}" data-id="all">查看全部 ${data.all.length} 家 ${icon('arrow')}</button>`)}
      ${segmentList(sorted.slice(0, 5), row => customerRow(S, row)) || empty('当前范围暂无客户')}
    </section>
    <section class="panel">
      ${sectionHead('客户结构')}
      <div class="management-structure-grid">${distribution(data)}</div>
    </section>
  </div>`;
}

export function assetDetail(S, P, id) {
  const data = model(S, P);
  const card = data.cards.find(card => card.id === id);
  const group = /^group-([a-z_]+)-(\d+)$/.exec(id);
  const dimension = group ? data.breakdown.find(({key}) => key === group[1]) : null;
  const entry = dimension?.entries[Number(group[2])];
  if (!card && !entry && id !== 'all') return '';
  const rows = card?.rows || entry?.rows || data.all;
  const title = card?.title || (entry ? `${dimension.title} · ${entry.name}` : '全部客户');
  const definition = id === 'stale' ? `按最近有效跟进计算，无记录时按建档日计算，达到 ${data.inactivityDays} 天。` : card?.note || '';
  return segmentDrawer(title, `${rows.length} 家 · 截至 ${S.today}${definition ? ` · ${definition}` : ''}`,
    segmentList(rows, row => customerRow(S, row, id === 'renewal')));
}
