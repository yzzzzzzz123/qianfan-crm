import {all} from '../database.mjs';
import {qfcrmSourceFields,itemSignature,paymentSignature} from '../qfcrm-source-fields.mjs';
import {contractSplit} from '../sales-policy.mjs';

export function commissionInputs(db,month){
 const users=all(db,"SELECT id,name,role FROM users WHERE active=1 AND business_member=1 AND developer_admin=0 AND role IN('sales','admin') ORDER BY id");
 const contracts=all(db,"SELECT * FROM contracts WHERE retired_at IS NULL AND lifecycle!='草稿' ORDER BY id"),items=all(db,'SELECT * FROM contract_items WHERE retired_at IS NULL'),payments=all(db,'SELECT * FROM payments'),sources=qfcrmSourceFields(db).contracts;
 const claims=[];
 for(const c of contracts){
  const f=sources.get(c.id),rows=items.filter(i=>i.contract_id===c.id),receipts=payments.filter(p=>p.contract_id===c.id);
  if(!f||f.contract_no!==c.contract_no||f.amount!==c.amount||itemSignature(rows)!==f.item_signature||paymentSignature(receipts)!==f.payment_signature||f.collection_status!=='已结清'||!f.received_at?.startsWith(month)||receipts.some(p=>p.status==='已到账'))continue;
  claims.push({contract_id:c.id,contract_name:c.name,contract_no:c.contract_no,sales_id:c.owner_id,date:f.received_at,amount:c.amount,product_amount:f.product_amount,service_amount:f.service_amount,source_record_id:f.source_record_id,trial_only:true,reason:'合同来源标记已结清，缺少逐笔到账流水；仅作待核对试算依据'});
 }
 function split(c){
  const original=contractSplit(c,items);if(original.valid)return original;
  const f=sources.get(c.id);
  if(!f||f.contract_no!==c.contract_no||f.amount!==c.amount||itemSignature(items.filter(i=>i.contract_id===c.id))!==f.item_signature)return original;
  const product=f.product_amount,service=Number.isSafeInteger(f.service_amount)?f.service_amount:product===c.amount?0:null;
  if(!Number.isSafeInteger(product)||!Number.isSafeInteger(service)||product+service!==c.amount)return original;
  const virtual=(kind,amount,margin)=>({id:null,contract_id:c.id,name:(f.product_names||[]).join('、')||c.name,kind,amount,margin,rate:null,source_record_id:f.source_record_id});
  return {valid:true,product,service,source_basis:true,items:[...(product?[virtual('标品',product,f.product_margin)]:[]),...(service?[virtual('交付',service,f.service_margin)]:[])]};
 }
 const basis=users.map(u=>{
  const own=contracts.filter(c=>c.owner_id===u.id),ids=new Set(own.map(c=>c.id));
  const actual=payments.filter(p=>ids.has(p.contract_id)&&p.status==='已到账'&&p.pay_date?.startsWith(month));
  const pending=claims.filter(p=>p.sales_id===u.id);
  return {sales_id:u.id,name:u.name,contract_count:own.length,contract_amount:own.reduce((s,c)=>s+c.amount,0),signed_amount:own.filter(c=>c.sign_date?.startsWith(month)).reduce((s,c)=>s+c.amount,0),receipt_count:actual.length,received_amount:actual.reduce((s,p)=>s+p.amount,0),source_claim_amount:pending.reduce((s,p)=>s+p.amount,0),source_claims:pending,contracts:own.map(c=>({id:c.id,contract_no:c.contract_no,name:c.name,amount:c.amount,sign_date:c.sign_date}))};
 });
 return {claims,basis,split};
}
