// Persisted item prices are integer cents. Match creation's per-line rounding;
// rounding a combined subtotal produces different answers for fractional quantities.
export function deriveQuoteTotals(rawItems) {
  const unknown=()=>({list_amount:null,discount_amount:null});
  let items=rawItems;
  if(typeof items==='string')try{items=JSON.parse(items);}catch{return unknown();}
  if(!Array.isArray(items)||items.length===0)return unknown();
  let listAmount=0,amount=0;
  for(const item of items){
    if(!item||typeof item!=='object'||Array.isArray(item)||!Number.isSafeInteger(item.list_price)||item.list_price<0||typeof item.quantity!=='number'||!Number.isFinite(item.quantity)||item.quantity<=0||typeof item.discount_rate!=='number'||!Number.isFinite(item.discount_rate)||item.discount_rate<0||item.discount_rate>1)return unknown();
    const list=Math.round(item.list_price*item.quantity),net=Math.round(list*item.discount_rate);
    if(!Number.isSafeInteger(list)||!Number.isSafeInteger(net))return unknown();
    listAmount+=list;amount+=net;
    if(!Number.isSafeInteger(listAmount)||!Number.isSafeInteger(amount))return unknown();
  }
  return {list_amount:listAmount,discount_amount:listAmount-amount};
}
