const money=value=>Number.isSafeInteger(value)&&value>=0;
const closed=stage=>['赢单','成交','输单','流失','搁置'].includes(stage);
const won=stage=>['赢单','成交'].includes(stage);
const levelRank={normal:0,attention:1,warning:2,critical:3};
const sumKnown=(rows,key)=>{
  if(rows.some(row=>!money(row[key])))return null;
  const sum=rows.reduce((total,row)=>total+row[key],0);
  return Number.isSafeInteger(sum)?sum:null;
};

// The caller supplies its already-authorized contract projection. Never query
// unscoped contracts here: an opportunity may be visible without every contract.
export function signedOpportunitySummary(opportunityId,contracts){
  const rows=contracts.filter(c=>c.opportunity_id===opportunityId&&!c.retired_at&&!c.terminated_at&&c.lifecycle!=='草稿');
  const amount=sumKnown(rows,'amount'),collected=sumKnown(rows,'collected');
  const product=sumKnown(rows,'product_amount'),service=sumKnown(rows,'service_amount');
  return {scope:'authorized_contracts',count:rows.length,contract_ids:rows.map(c=>c.id),amount,
    product_amount:product,service_amount:service,collected,
    outstanding:amount===null||collected===null?null:sumKnown(rows.map(c=>({open:money(c.amount)&&money(c.collected)?Math.max(0,c.amount-c.collected):null})),'open')};
}

export function opportunityForecast(opportunity){
  const value=won(opportunity.stage)?opportunity.initial_amount:opportunity.amount;
  const amount=money(value)?value:null;
  const product=amount!==null&&money(opportunity.product_amount)&&opportunity.product_amount<=amount?opportunity.product_amount:null;
  return {forecast_amount:amount,forecast_product_amount:product,
    forecast_service_amount:amount!==null&&product!==null?amount-product:null,
    forecast_source:amount===null?'unknown':won(opportunity.stage)?'initial_snapshot':'current_estimate',
    forecast_product_source:product===null?'unknown':'stored_estimate'};
}

export function currentQuoteIds(quotes){
  const current=new Map();
  const time=quote=>Number.isFinite(Date.parse(quote.created_at))?Date.parse(quote.created_at):-Infinity;
  for(const quote of quotes){
    const previous=current.get(quote.opportunity_id);
    if(!previous||time(quote)>time(previous)||time(quote)===time(previous)&&quote.id>previous.id)current.set(quote.opportunity_id,quote);
  }
  return new Map([...current].map(([id,quote])=>[id,quote.id]));
}

export function quoteVersion(quote,currentId,asOf){
  const isCurrent=quote.id===currentId;
  return {is_current:isCurrent,quote_status:!isCurrent?'历史版本':quote.valid_until&&quote.valid_until<asOf?'当前已过期':'当前有效'};
}

export function opportunityDiagnostics(opportunity,base,{asOf,rules,inactive,currentQuote,keyContactStale=false}={}){
  const diagnostics=[];
  const add=(code,message,level='attention')=>diagnostics.push({code,message,level});
  if(closed(opportunity.stage))return {risk:{...base},diagnostics,risk_reasons:[]};
  if(base.level!=='normal')add('stage_or_followup_risk',base.label,base.level);
  if(base.overdue>0&&base.label!=='跟进逾期')add('followup_overdue',`跟进已逾期 ${base.overdue} 天`,'warning');
  if(inactive>=rules.inactivity_days)add('interaction_stale','长期未互动','critical');
  else if(base.level==='normal'&&base.days>=base.threshold*rules.attention_ratio)add('stage_near_stall','接近停滞阈值');
  if(currentQuote?.valid_until&&currentQuote.valid_until<asOf)add('current_quote_expired','当前报价已过期');
  if(keyContactStale)add('key_contact_stale','关键人待触达');
  if(!String(opportunity.next_action||'').trim())add('next_action_missing','下一步未安排');
  if(!opportunity.follow_date)add('follow_date_missing','下次跟进日期未安排');
  if(opportunity.stage==='商务'&&!opportunity.expected_date)add('expected_date_missing','预计签约日待补充');
  if(opportunity.expected_date&&opportunity.expected_date<asOf)add('expected_date_overdue','预计签约日已延期','warning');
  const primary=diagnostics.reduce((best,item)=>!best||levelRank[item.level]>levelRank[best.level]?item:best,null);
  return {risk:primary?{...base,level:primary.level,label:primary.message}:{...base},diagnostics,risk_reasons:diagnostics.map(item=>item.message)};
}

export function addSignedDiagnostics(opportunity){
  if(won(opportunity.stage)&&opportunity.signed_summary?.count===0){
    const diagnostic={code:'won_no_visible_signed_contract',message:'赢单但暂无可见有效合同，请核对关联记录',level:'attention'};
    opportunity.diagnostics.push(diagnostic);
    opportunity.risk_reasons.push(diagnostic.message);
    if(opportunity.aiAnalysis?.risks)opportunity.aiAnalysis.risks.push(diagnostic.message);
  }
  return opportunity;
}
