import {assert,cents} from './domain.mjs';
export function itemProfit(body,amount,kind,original={}){
 const expense=body.business_expense===undefined?(original.business_expense||0):cents(body.business_expense||0,'合同费用支出',true);
 let base=original.margin_before_expense??original.margin??null;
 const hasBase=body.margin_before_expense!==undefined,hasMargin=body.margin!==undefined,hasRate=body.margin_rate!==undefined&&body.margin_rate!==''&&body.margin_rate!==null;
 if(hasBase||hasMargin){const value=hasBase?body.margin_before_expense:body.margin;base=value==null||value===''?null:cents(value,'费用前毛利',true);}
 if(body.margin_rate===null&&!hasBase&&!hasMargin)base=null;
 if(hasRate){const rate=Number(body.margin_rate);assert(Number.isFinite(rate)&&rate>=0&&rate<=1,'毛利率须为0至100%');const calculated=Math.round(amount*rate);assert(!(hasBase||hasMargin)||base===null||base===calculated,'毛利金额与毛利率计算不一致');base=calculated;}
 if((!Object.keys(original).length||body.reset_margin===true)&&!hasBase&&!hasMargin&&!hasRate&&['实施','交付'].includes(kind))base=amount;
 assert(base===null||base<=amount,'费用前毛利不能超过明细金额');
 return {business_expense:expense,margin_before_expense:base,margin:base===null?null:base-expense};
}
