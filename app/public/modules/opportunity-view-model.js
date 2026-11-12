const closed=stage=>['赢单','成交','输单','流失','搁置'].includes(stage);
const won=stage=>['赢单','成交'].includes(stage);
const norm=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g,' ').trim();
const number=value=>typeof value==='number'&&Number.isFinite(value);
export function opportunityMatchesQuery(S,o,query){
  const customer=(S.customers||[]).find(c=>Number(c.id)===Number(o.customer_id));
  const owner=(S.users||[]).find(u=>Number(u.id)===Number(o.owner_id));
  const text=norm([o.name,o.code,o.reference,o.next_action,o.owner_label,owner?.name,customer?.name,customer?.short_name,customer?.industry,customer?.region,...(o.risk_reasons||[]).map(v=>typeof v==='string'?v:v.message)].filter(Boolean).join(' '));
  return norm(query).split(' ').filter(Boolean).every(part=>text.includes(part));
}
export function opportunityActualAmount(o){
  return won(o.stage)&&o.signed_summary?o.signed_summary.amount:o.amount;
}
export function opportunityActualProduct(o){
  return won(o.stage)&&o.signed_summary?o.signed_summary.product_amount:o.product_amount;
}
export function selectOpportunities(S,P={}){
  const ledger=P.opportunityView==='ledger',owner=ledger?'':P.owner;
  const condition=P.risk||(ledger?'all':'active');
  let rows=(S.opportunities||[]).filter(o=>S.actor.role!=='sales'||Number(o.owner_id)===Number(S.actor.id));
  rows=rows.filter(o=>(!owner||Number(o.owner_id)===Number(owner))&&(!P.stage||o.stage===P.stage)&&(!P.q||opportunityMatchesQuery(S,o,P.q))&&(!P.saleType||o.sale_type===P.saleType));
  if(P.customerLevel)rows=rows.filter(o=>(S.customers||[]).some(c=>c.id===o.customer_id&&c.manual_level===P.customerLevel));
  if(P.from||P.to)rows=rows.filter(o=>o.created_at&&(!P.from||o.created_at.slice(0,10)>=P.from)&&(!P.to||o.created_at.slice(0,10)<=P.to));
  if(condition==='active')rows=rows.filter(o=>!closed(o.stage));
  else if(condition==='won')rows=rows.filter(o=>won(o.stage));
  else if(condition==='today')rows=rows.filter(o=>!closed(o.stage)&&(!!o.follow_date&&o.follow_date<=S.today||P.followupScope&&o.risk?.level&&o.risk.level!=='normal'));
  else if(condition==='risk')rows=rows.filter(o=>!closed(o.stage)&&o.risk?.level&&o.risk.level!=='normal');
  if(ledger)return rows;
  const severity=o=>({critical:0,warning:1,attention:2,normal:3}[o.risk?.level]??3);
  const date=v=>v||'9999-12-31',compareDate=(a,b)=>date(a).localeCompare(date(b));
  const sort=P.opportunitySort||'priority';
  return [...rows].sort((a,b)=>{
    let order=0;
    if(sort==='expected_date')order=compareDate(a.expected_date,b.expected_date);
    else if(sort==='follow_date')order=compareDate(a.follow_date,b.follow_date);
    else if(sort==='amount'){
      const av=Object.hasOwn(a,'forecast_amount')?a.forecast_amount:a.amount,bv=Object.hasOwn(b,'forecast_amount')?b.forecast_amount:b.amount;
      order=number(av)&&number(bv)?bv-av:number(av)?-1:number(bv)?1:0;
    }else order=Number(closed(a.stage))-Number(closed(b.stage))||Number(!(a.follow_date&&a.follow_date<S.today))-Number(!(b.follow_date&&b.follow_date<S.today))||severity(a)-severity(b)||compareDate(a.follow_date,b.follow_date);
    return order||compareDate(a.expected_date,b.expected_date)||String(a.id).localeCompare(String(b.id),'zh-CN',{numeric:true});
  });
}
