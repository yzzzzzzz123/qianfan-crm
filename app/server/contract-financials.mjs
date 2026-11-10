import {contractSplit} from './sales-policy.mjs';
import {contractSourceFields} from './qfcrm-source-fields.mjs';
const sum=(rows,fn)=>rows.reduce((s,r)=>s+fn(r),0);
export function contractFinancials(contract,items,{hideMargin=false}={}) {
  const split=contractSplit(contract,items);
  const rows=items.filter(i=>i.contract_id===contract.id&&!i.retired_at);
  const products=rows.filter(i=>i.kind==='标品'),services=rows.filter(i=>i.kind!=='标品');
  const margin=group=>hideMargin||!split.valid||group.some(i=>i.margin===null||i.margin===undefined)?null:sum(group,i=>i.margin);
  const productMargin=margin(products),serviceMargin=margin(services);
  return {
    product_names:[...new Set(rows.map(i=>i.name).filter(Boolean))],
    product_types:[...new Set(rows.map(i=>i.kind).filter(Boolean))],
    financials_complete:split.valid,
    product_amount:split.valid?split.product:null,service_amount:split.valid?split.service:null,
    business_expense:hideMargin?null:sum(rows,i=>i.business_expense||0),
    margin_before_expense:hideMargin||rows.some(i=>(i.margin_before_expense??i.margin)==null)?null:sum(rows,i=>i.margin_before_expense??i.margin),
    total_margin_rate:hideMargin||productMargin===null||serviceMargin===null?null:(productMargin+serviceMargin)/contract.amount,
    product_margin:productMargin,service_margin:serviceMargin,
    product_margin_rate:productMargin!==null&&split.product>0?productMargin/split.product:null,
    total_margin:productMargin===null||serviceMargin===null?null:productMargin+serviceMargin,
  };
}

// One canonical financial projection for contract pages and receipt accounting.
export function effectiveContractFinancials(c,items,payments,facts,options={}) {
 return {...contractFinancials(c,items,options),...contractSourceFields(c,items,payments,facts,options)};
}
