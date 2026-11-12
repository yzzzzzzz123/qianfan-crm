import {all} from '../database.mjs';
import {today} from '../domain.mjs';
import {effectiveContractFinancials} from '../contract-financials.mjs';
import {qfcrmSourceFields} from '../qfcrm-source-fields.mjs';
import {commissionInputs} from './commission-inputs.mjs';

export const RECEIPT_MARGIN_SCHEME='sales-receipt-margin-v2';
export const isServiceItem=i=>['定开','运维'].includes(i.kind);
const known=v=>Number.isSafeInteger(v)&&v>=0;
const receiptRef=(p,code)=>({payment_id:p.id,amount:p.amount,date:p.pay_date||null,code});
const missingDate='已到账记录缺少到账日期，未计入当月金额';

// Decimal rates and rational contract margins round exactly once in integer cents.
export function roundedRatio(amount,numerator,denominator=1){
  const n=BigInt(amount)*BigInt(numerator),d=BigInt(denominator);
  if(d<=0n||n<0n)throw new Error('Invalid nonnegative monetary ratio');
  return Number((n*2n+d)/(d*2n));
}
export function rateRatio(rate){
  const [mantissa,exponent='0']=String(rate).toLowerCase().split('e');
  const decimals=(mantissa.split('.')[1]||'').length,scale=decimals-Number(exponent);
  return scale>=0?[BigInt(mantissa.replace('.','')),10n**BigInt(scale)]:[BigInt(mantissa.replace('.',''))*10n**BigInt(-scale),1n];
}
export const roundRate=(amount,rate)=>roundedRatio(amount,...rateRatio(rate));

// Traverse all dated receipts before filtering by month: installment residue stays
// on its actual receipt, including when installments fall in different months.
export function receiptMarginLedger(db,month){
  const inputs=commissionInputs(db,month),sources=qfcrmSourceFields(db).contracts;
  const day=today();
  const contracts=all(db,"SELECT * FROM contracts WHERE retired_at IS NULL AND lifecycle!='草稿' ORDER BY id");
  const items=all(db,'SELECT * FROM contract_items WHERE retired_at IS NULL ORDER BY id');
  const payments=all(db,'SELECT * FROM payments ORDER BY pay_date,id'),rows=[];
  for(const c of contracts){
    const ownedItems=items.filter(i=>i.contract_id===c.id),paid=payments.filter(p=>p.contract_id===c.id);
    const financials=effectiveContractFinancials(c,ownedItems,paid,sources.get(c.id));
    const split=inputs.split(c),services=split.items.filter(i=>i.kind!=='标品'&&i.amount>0);
    const serviceConfirmed=services.every(isServiceItem);
    const productRate=financials.product_margin_rate;
    const productKnown=Number.isFinite(productRate)&&productRate>=0&&productRate<=1;
    // An imported explicit rate is authoritative until its item fingerprint is
    // invalidated. A rate derived from item margins keeps the original fraction
    // so e.g. 3 cents × (1/6) rounds to 1 cent rather than a floating-point zero.
    const productRatio=productKnown?(financials.source_items_edited===false?rateRatio(productRate):known(financials.product_margin)&&financials.product_amount>0?[financials.product_margin,financials.product_amount]:rateRatio(productRate)):null;
    const serviceKnown=known(financials.service_margin)&&known(financials.service_amount)&&financials.service_amount>0;
    let cumulativeProduct=0,cumulativeService=0,productGross=0,serviceGross=0;
    const undated=paid.filter(p=>p.status==='已到账'&&!p.pay_date);
    let blockingReceipt=undated.length?receiptRef(undated[0],'receipt_date_missing'):null;
    const dated=paid.filter(p=>p.status==='已到账'&&p.pay_date&&p.pay_date<=day);
    for(const p of dated){
      const diagnostics=[],priorReceipt=blockingReceipt;
      const addIssue=(code,message,extra)=>diagnostics.push({code,message,...extra});
      const dateConflict=c.sign_date>day||p.pay_date<c.sign_date;
      let exceedsSplit=false;
      let product=p.product_amount,service=null,pg=null,sg=null;
      if(dateConflict){
        addIssue('receipt_date_conflict','到账日期早于合同签订日期或合同签订日期尚未到达');
        blockingReceipt??=receiptRef(p,'receipt_date_conflict');
      }
      if(!split.valid)addIssue('contract_items_incomplete',split.reason);
      else{
        if(product==null){if(split.product===0)product=0;else if(split.service===0)product=p.amount;}
        if(!known(product)||product>p.amount){
          product=null;
          addIssue('receipt_split_missing','混合合同本笔产品回款分配未填写或无效');
          blockingReceipt??=receiptRef(p,'receipt_split_missing');
        }
        else{
          service=p.amount-product;
          cumulativeProduct+=product;cumulativeService+=service;
          if(priorReceipt&&!dateConflict)addIssue('receipt_prior_incomplete','前序到账流水资料未齐，累计毛利待核对',{blocking_receipt:priorReceipt});
          exceedsSplit=cumulativeProduct>split.product||cumulativeService>split.service;
          if(exceedsSplit)addIssue('receipt_split_exceeded','累计产品或服务回款超过合同对应金额');
          if(!diagnostics.length){
            if(product===0)pg=0;
            else if(productKnown){const next=roundedRatio(cumulativeProduct,...productRatio);pg=next-productGross;productGross=next;}
            else addIssue('margin_missing','产品毛利率缺失，产品回款毛利待核对');
            if(service===0)sg=0;
            else if(serviceConfirmed&&serviceKnown){const next=roundedRatio(cumulativeService,financials.service_margin,financials.service_amount);sg=next-serviceGross;serviceGross=next;}
            else if(!serviceConfirmed)addIssue('contract_items_incomplete','服务分类待核对：仅定开、运维属于开发运维；实施、交付及未分类不自动计提');
            else addIssue('team_service_margin_missing','服务毛利或服务金额缺失，团队服务回款毛利待核对');
          }
        }
      }
      if(!p.pay_date.startsWith(month))continue;
      rows.push({payment_id:p.id,contract_id:c.id,contract_no:c.contract_no,contract_name:c.name,sales_id:c.owner_id,sign_date:c.sign_date,terminated_at:c.terminated_at,date:p.pay_date,amount:p.amount,product_amount:product,service_received:service,
        product_margin_rate:productKnown?productRate:null,service_margin_rate:serviceKnown?financials.service_margin/financials.service_amount:null,
        product_gross_margin:pg,service_gross_margin:sg,gross_margin:pg===null||sg===null?null:pg+sg,
        service_classification_confirmed:serviceConfirmed,source_basis:!!split.source_basis,items:split.items,
        allocation_valid:split.valid&&product!==null&&!dateConflict&&!priorReceipt&&!exceedsSplit,diagnostics,issues:diagnostics.map(i=>i.message)});
    }
    for(const p of undated.filter(p=>p.created_at?.startsWith(month)))rows.push({payment_id:p.id,contract_id:c.id,contract_no:c.contract_no,contract_name:c.name,sales_id:c.owner_id,sign_date:c.sign_date,terminated_at:c.terminated_at,date:null,amount:p.amount,product_amount:null,service_received:null,product_gross_margin:null,service_gross_margin:null,gross_margin:null,items:[],allocation_valid:false,diagnostics:[{code:'receipt_date_missing',message:missingDate}],issues:[missingDate]});
  }
  return {rows:rows.sort((a,b)=>String(a.date).localeCompare(String(b.date))||a.payment_id-b.payment_id),claims:inputs.claims,basis:inputs.basis};
}
