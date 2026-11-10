import {esc,icon,empty} from '../ui.js';

export const manualCreateActions=Object.freeze({
  'new-customer':'customer','new-contact':'contact','new-opportunity':'opportunity','new-activity':'activity',
  'new-quote':'quote','new-contract':'contract','new-payment':'payment','new-payment-plan':'payment-plan-create',convert:'convert',
});
export const manualFormRoles=Object.freeze({
  customer:['admin','sales'],contact:['admin','sales'],opportunity:['admin','sales'],activity:['admin','sales','pm'],quote:['admin','sales'],
  contract:['admin','sales'],convert:['admin','sales'],payment:['admin','sales'],'payment-plan-create':['admin','sales'],user:[],target:['admin'],'archive-contract':['admin','sales'],
  'document-templates':['admin'],rules:['admin'],'finance-rules':['admin'],'sales-commission-policy':['admin'],
  'commission-confirm':['admin'],'commission-pay':['admin'],'performance-review':['admin'],
});
const labels={customer:'新建客户',contact:'新建联系人',opportunity:'新建商机',activity:'新建跟进',quote:'新建报价',contract:'新增合同',payment:'新建回款',target:'设置季度目标','document-templates':'填写公司模板',rules:'设置阶段与动作','finance-rules':'设置提成与绩效规则'};
export function manualChoices(S,P) {
  const common=['customer','contact','opportunity','activity','quote','contract','payment'];
  const byView={workbench:common,analytics:common,personal:common,customers:['customer','contact'],assets:['customer','contact'],opportunities:['opportunity','quote','activity'],funnel:['opportunity'],activities:['activity'],contracts:['contract'],collections:['payment']};
  let types=byView[P.view]||[];
  // 绩效、提成和季度目标在对应记录上操作，避免再次选择同一个对象。
  if(['commissions','performance'].includes(P.view))return [];
  return types.filter(type=>manualFormRoles[type]?.includes(S.actor.role)).map(type=>({type,label:labels[type]}));
}
export function manualEntryEnabled(S,P) {
  return manualChoices(S,P).length>0;
}
export function manualChooser(S,P) {
  const choices=manualChoices(S,P);
  return `<header class="dialog-head"><h2>手动导入</h2><button class="icon-btn" data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="dialog-body manual-entry-options">${choices.map(c=>`<button class="manual-entry-option" data-action="manual-open" data-type="${esc(c.type)}" data-id="${esc(c.id??'')}"><span>${icon(c.type==='payment'?'wallet':c.type==='customer'||c.type==='contact'?'customers':'note')}<b>${esc(c.label)}</b>${c.hint?`<small>${esc(c.hint)}</small>`:''}</span>${icon('chevron')}</button>`).join('')||empty('暂无可填写的记录','')}</div>`;
}
