import { badge, customerName, empty, esc, icon, isClosedStage, isLostStage, isWonStage, plainMoney, salesName, sectionHead } from '../ui.js';
import { workbenchForecast } from './workbench-view-model.js';
import { businessDate } from './management-finance.js';
import { segmentCards, segmentDrawer, segmentFilters, segmentList } from './management-segments.js';

const action = 'management-funnel-detail';
const dateRangeError = P => P.from && P.to && P.from > P.to;
const stageOf = value => isWonStage(value) ? '赢单' : isLostStage(value) ? '输单' : value || '阶段待补';
const signedAmount = o => o.signed_summary?.amount ?? null;
const knownMoney = value => Number.isSafeInteger(value) && value >= 0;
const amountLabel = stage => isWonStage(stage) ? '有效签约' : isClosedStage(stage) ? '原预计金额' : '预计金额';
const isRisk = o => !isClosedStage(o.stage) && !!o.risk?.level && o.risk.level !== 'normal';
const stageDays = o => Number.isFinite(o.risk?.days) && o.risk.days >= 0 ? o.risk.days : null;

function overStageLimit(S, o) {
  const limit = o.risk?.threshold ?? S.rules?.thresholds?.[o.stage];
  const days = stageDays(o);
  return !isClosedStage(o.stage) && Number.isFinite(limit) && limit > 0 && days !== null && days > limit;
}

function amounts(rows, getAmount) {
  const known = rows.map(getAmount).filter(knownMoney);
  return {total: known.reduce((sum, amount) => sum + amount, 0), missing: rows.length - known.length, allMissing: rows.length > 0 && !known.length};
}

function amountText({total, missing, allMissing}) {
  if (allMissing) return '金额待核对';
  return `${missing ? '已知 ' : ''}${plainMoney(total)}`;
}

function scope(S, P) {
  const owner = S.actor.role === 'sales' ? S.actor.id : P.owner;
  const grade = new Map((S.customers || []).map(c => [Number(c.id), c.manual_level]));
  return (S.opportunities || []).filter(o => {
    if (o.archived_at || owner && Number(o.owner_id) !== Number(owner)) return false;
    if (P.level && grade.get(Number(o.customer_id)) !== P.level || P.saleType && o.sale_type !== P.saleType) return false;
    if (!P.from && !P.to) return true;
    const created = businessDate(o.created_at);
    return created && (!P.from || created >= P.from) && (!P.to || created <= P.to);
  });
}

function model(S, P) {
  const all = scope(S, P);
  const active = all.filter(o => !isClosedStage(o.stage));
  const won = all.filter(o => isWonStage(o.stage));
  const concluded = all.filter(o => isWonStage(o.stage) || isLostStage(o.stage));
  const risks = active.filter(isRisk);
  const ids = new Set(all.map(o => Number(o.id)));
  const changes = (S.stageHistory || []).filter(row => ids.has(Number(row.opportunity_id)) &&
    row.from_stage && row.to_stage && stageOf(row.from_stage) !== stageOf(row.to_stage) && businessDate(row.at));
  const stages = [...new Set([...(S.stages || []).map(stageOf), ...all.map(o => stageOf(o.stage))])];
  return {all, active, won, concluded, risks, stages, coverage: new Set(changes.map(row => Number(row.opportunity_id))).size};
}

function summaryCards(data) {
  const metric = (id, title, rows, getAmount, symbol) => {
    const amount = amounts(rows, getAmount);
    return {id, title, rows, value: amountText(amount), note: `${rows.length} 条商机${amount.missing ? ` · ${amount.missing} 条金额待核对` : ''}`, symbol};
  };
  return [
    metric('active', '在途预计金额', data.active, workbenchForecast, 'opportunities'),
    metric('signed', '当前有效签约', data.won, signedAmount, 'contracts'),
    {
      id: 'concluded', title: '已结案赢单率', rows: data.concluded,
      value: data.concluded.length ? `${Math.round(data.won.length / data.concluded.length * 100)}%` : '—',
      note: `数量赢单率 · 赢单 ${data.won.length} / 已赢或已输 ${data.concluded.length}`, symbol: 'chart',
    },
    metric('risks', '风险商机预计金额', data.risks, workbenchForecast, 'alert'),
  ];
}

function stageCard(S, data, stage, index) {
  const rows = data.all.filter(o => stageOf(o.stage) === stage);
  const closed = isClosedStage(stage);
  const days = rows.map(stageDays).filter(day => day !== null);
  const average = !closed && days.length ? Math.round(days.reduce((sum, day) => sum + day, 0) / days.length) : null;
  const over = rows.filter(o => overStageLimit(S, o)).length;
  const won = isWonStage(stage);
  const amount = amounts(rows, won ? signedAmount : workbenchForecast);
  return `<button type="button" class="management-stage-card" data-action="${action}" data-id="stage-${index}">
    <span class="management-stage-title">${esc(stage)} <b>${rows.length} 条</b></span>
    <span>${amountLabel(stage)} <strong>${amountText(amount)}</strong>${amount.missing ? ` · ${amount.missing} 条金额待核对` : ''}</span>
    ${closed ? '' : `<span>${average === null ? '平均停留待核对' : `平均停留 ${average} 天`} · 超期 ${over} 条</span>`}
  </button>`;
}

function opportunityRow(S, o) {
  const won = isWonStage(o.stage);
  const amount = won ? signedAmount(o) : workbenchForecast(o);
  const product = won ? o.signed_summary?.product_amount
    : Object.hasOwn(o, 'forecast_product_amount') ? o.forecast_product_amount : o.product_amount;
  const days = stageDays(o);
  const details = [salesName(S, o), !isClosedStage(o.stage) && days !== null ? `停留 ${days} 天` : '',
    overStageLimit(S, o) ? '阶段超期' : '', o.risk?.level !== 'normal' ? o.risk?.label : ''].filter(Boolean);
  return `<li>
    <div><button type="button" class="text-link" data-action="opportunity" data-id="${esc(o.id)}">${esc(o.name || '商机名称待补')}</button>
      <p>${esc(customerName(S, o.customer_id))} · ${badge(stageOf(o.stage), won ? 'success' : 'neutral')}</p>
      <small>${esc(details.join(' · '))}</small></div>
    <div class="management-segment-end"><strong>${knownMoney(amount) ? plainMoney(amount) : '金额待核对'}</strong>
      <small>${amountLabel(o.stage)}</small><small>产品 ${knownMoney(product) ? plainMoney(product) : '待核对'}</small></div>
  </li>`;
}

export function funnelPage(S, P = {}) {
  const controls = segmentFilters(S, P, true);
  if (dateRangeError(P)) return `<link rel="stylesheet" href="./modules/management-segments.css">${controls}<p class="form-error" role="alert">起始日期不能晚于结束日期。</p>`;
  const data = model(S, P);
  const coverage = data.all.length
    ? `${data.all.length} 条商机中，${data.coverage} 条有可用的阶段变更记录。`
    : '当前范围暂无商机。';
  const riskList = data.risks.slice().sort((a, b) => (stageDays(b) ?? -1) - (stageDays(a) ?? -1));
  return `<link rel="stylesheet" href="./modules/management-segments.css"><div class="management-segments">
    ${controls}
    <p class="management-segment-context">截至 ${esc(S.today)} · 日期按商机创建时间筛选。赢单金额取当前可见的有效关联合同。</p>
    ${segmentCards(action, summaryCards(data))}
    <section class="panel">
      ${sectionHead('当前阶段分布', '每条商机按当前阶段归类。点阶段查看商机。')}
      <div class="management-stage-grid">${data.stages.map((stage, index) => stageCard(S, data, stage, index)).join('')}</div>
    </section>
    <section class="panel">
      ${sectionHead('风险商机', '按当前阶段停留天数排序', `<button type="button" class="text-link" data-action="${action}" data-id="risks">查看全部 ${data.risks.length} 条 ${icon('arrow')}</button>`)}
      ${segmentList(riskList.slice(0, 5), o => opportunityRow(S, o)) || empty('当前范围暂无风险商机')}
    </section>
    <section class="panel management-history">${sectionHead('阶段历史覆盖', coverage)}
      ${data.all.length ? '<p>期间转化按阶段变更日期统计，需要完整的阶段历史。</p>' : ''}
    </section>
  </div>`;
}

export function funnelDetail(S, P, id) {
  if (dateRangeError(P)) return '';
  const data = model(S, P);
  const stage = /^stage-(\d+)$/.exec(id);
  const card = summaryCards(data).find(card => card.id === id);
  const stageName = stage ? data.stages[Number(stage[1])] : null;
  if (!card && !stageName) return '';
  const rows = stageName ? data.all.filter(o => stageOf(o.stage) === stageName) : card.rows;
  const note = stageName ? `${rows.length} 条商机 · 截至 ${S.today}` : `${card.value} · ${card.note}`;
  return segmentDrawer(stageName || card.title, note, segmentList(rows, o => opportunityRow(S, o)));
}
