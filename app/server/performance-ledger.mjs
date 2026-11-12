import {performancePolicy} from '../public/modules/performance-policy.js';

// Date-only imports are business dates. Timestamps are accounted for in China,
// regardless of the server's operating-system time zone.
const chinaDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export function businessDate(value) {
  if(typeof value!=='string')return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
  if(!/^\d{4}-\d{2}-\d{2}[T ]/.test(value))return '';
  const normalized=value.replace(' ','T'),zoned=/Z$|[+-]\d{2}:?\d{2}$/.test(normalized)?normalized:normalized+'+08:00';
  const date=new Date(zoned);
  return Number.isFinite(date.getTime())?chinaDate.format(date):'';
}
const rounded=value=>Math.round(value*100)/100;
const categories=[['meeting','线上会议','线上会议'],['visit','现场拜访','现场拜访'],['quote','对客报价','对客报价'],['funnel','新增商机',null]];

export function processLedger(opportunities,activities,quotes,userId,month,settings={}) {
  const policy=performancePolicy(settings),opps=new Map(opportunities.map(o=>[o.id,o]));
  const ledger=[],quoteDays=new Set();
  const base=(o={})=>({opportunity_id:o.id,opportunity_name:o.name||'历史商机',customer_name:o.customer_name||'',opportunity_archived:!!o.archived_at});
  for(const q of quotes){
    const date=businessDate(q.created_at);
    if(q.user_id!==userId||!date.startsWith(month))continue;
    const o=opps.get(q.opportunity_id)||{id:q.opportunity_id};
    quoteDays.add(`${q.opportunity_id}:${date}`);
    ledger.push({...base(o),kind:'quote',source_id:q.id,quote_id:q.id,category:'quote',title:q.name||'报价记录',date,amount:q.amount,recorded_user_id:q.user_id,credited_user_id:q.user_id,counted:true,points:policy.quote,reason:'按报价记录计分'});
  }
  const countedQuoteEvents=new Set();
  // Stable event selection makes a same-day quote group explainable and repeatable.
  for(const [index,a] of activities.map((a,index)=>[index,a]).sort((a,b)=>(a[1].id??a[0])-(b[1].id??b[0]))){
    const o=opps.get(a.opportunity_id)||{id:a.opportunity_id};
    const credited=a.credited_user_id??a.user_id??o.owner_id;
    const date=businessDate(a.activity_date);
    if(credited!==userId||!date.startsWith(month))continue;
    const category=categories.find(([, ,type])=>type===a.activity_type)?.[0]||'other';
    let counted=category!=='other'&&!a.voided_at,reason=counted?'按有效原始行为计分':'该行为类型不计入过程分';
    if(a.voided_at)reason='记录已作废';
    if(counted&&category==='quote'){
      const key=`${a.opportunity_id}:${date}`;
      if(quoteDays.has(key)){counted=false;reason='同日已有报价记录，不重复计分';}
      else if(countedQuoteEvents.has(key)){counted=false;reason='同一商机同日报价行为已计入，不重复计分';}
      else countedQuoteEvents.add(key);
    }
    ledger.push({...base(o),kind:'activity',source_id:a.id??index,event_id:a.activity_id?a.id:null,activity_id:a.activity_id??a.id,category,title:a.summary||a.activity_type,date,activity_type:a.activity_type,source:a.source,recorded_user_id:a.user_id,credited_user_id:credited,counted,points:counted?policy[category]:0,reason,voided_at:a.voided_at||null,void_reason:a.void_reason||'',summary:a.summary});
  }
  for(const o of opportunities){
    const date=businessDate(o.created_at),credited=o.created_owner_id??o.owner_id;
    if(credited!==userId||!date.startsWith(month))continue;
    const amount=o.initial_amount??o.amount;
    const points=amount<980000?policy.funnel_low:amount<=5000000?policy.funnel_mid:policy.funnel_high;
    ledger.push({...base(o),kind:'opportunity',source_id:o.id,category:'funnel',title:o.name||'新增商机',date,amount,counted:true,points,credited_user_id:credited,recorded_user_id:o.created_by||null,reason:o.creation_attribution==='unverified'?'按当前归属计入，历史新增归属待核对':'按新增商机初始金额计分',attribution_unverified:o.creation_attribution==='unverified'});
  }
  const category_scores=categories.map(([key,label])=>{
    const rows=ledger.filter(x=>x.category===key),scored=rows.filter(x=>x.counted);
    return {key,label,count:scored.length,record_count:rows.length,rate:key==='funnel'?null:policy[key],points:rounded(scored.reduce((sum,x)=>sum+x.points,0))};
  });
  const points=Object.fromEntries(category_scores.map(x=>[x.key,x]));
  const uncapped_raw=rounded(category_scores.reduce((sum,x)=>sum+x.points,0)),raw=Math.min(policy.cap,uncapped_raw);
  return {process:{meeting:points.meeting.count,visit:points.visit.count,quote:points.quote.count,funnelCount:points.funnel.count,raw,weighted:rounded(raw/policy.cap*policy.process_weight)},uncapped_raw,category_scores,score_ledger:ledger.sort((a,b)=>b.date.localeCompare(a.date)||(b.source_id??0)-(a.source_id??0))};
}
