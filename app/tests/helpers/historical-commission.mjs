import {run,one} from '../../server/database.mjs';
export function historicalCommission(f,p,{paid=false}={}){
 const id=Number(run(f.db,'INSERT INTO commission_batches(sales_id,kind,period,base,rate,amount,status,snapshot,created_at,confirmed_by,paid_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',p.sales_id,p.kind,p.period,p.base,p.rate,p.due,paid?'paid':'confirmed',JSON.stringify(p),new Date().toISOString(),1,paid?'2026-12-01':null).lastInsertRowid);
 for(const l of p.lines.filter(l=>l.amount>0))run(f.db,'INSERT INTO commission_lines(batch_id,contract_id,item_id,base,rebate_rate,rate,amount,component) VALUES(?,?,?,?,?,?,?,?)',id,l.contract_id,l.item_id,l.base,l.rebate_rate??0,l.rate,l.amount,l.component||'legacy');
 return {status:200,body:{id}};
}
