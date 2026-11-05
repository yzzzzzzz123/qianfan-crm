import {assert,text} from '../domain.mjs';
import {all} from '../database.mjs';

const allowed=new Set(['customer_id','owner_id','name','contract_no','sale_type','order_type','renewal_tag','payment_type','sign_date','valid_until','created_at','project_status','collaborator_pm','delivery_staff','project_note','scope']);
export function maintainContract(ctx,id){
 const {db,b,actor,scoped,mutate}=ctx,c=scoped('contracts',id,actor,actor.role==='pm'?'follow':'edit');
 assert(Object.keys(b).every(k=>['fields','items','payments','reason'].includes(k)),'维护资料包含不支持字段');
 assert(b.fields&&typeof b.fields==='object'&&!Array.isArray(b.fields)&&Object.keys(b.fields).every(k=>allowed.has(k)),'合同维护字段无效');
 const reason=text(b.reason,'变更原因',1000);
 if(b.payments!==undefined){
  assert(actor.role==='admin','仅管理员可维护回款',403);assert(Array.isArray(b.payments)&&b.payments.length<=100,'回款明细无效');
  const known=new Set(all(db,'SELECT id FROM payments WHERE contract_id=?',c.id).map(p=>p.id)),seen=new Set();
  for(const p of b.payments){assert(p&&typeof p==='object'&&!Array.isArray(p),'回款明细无效');if(p.id!=null){assert(Number.isSafeInteger(p.id)&&known.has(p.id)&&!seen.has(p.id),'回款不属于当前合同或重复');seen.add(p.id);}}
 }
 const fields={...b.fields,...(b.items!==undefined?{items:b.items}:{}),reason};
 const saveContract=()=>{if(Object.keys(fields).length>1)mutate(`/api/contracts/${c.id}`,'PATCH',fields,actor);};
 const savePayments=()=>{for(const row of b.payments||[]){const {id:paymentId,...payment}=row;const payload={...payment,contract_id:payment.contract_id||c.id,reason};if(paymentId)mutate(`/api/payments/${paymentId}/details`,'PATCH',payload,actor);else {delete payload.reason;mutate('/api/payments','POST',payload,actor);}}};
 const smaller=Array.isArray(b.items)&&b.items.reduce((sum,i)=>sum+Math.round(Number(i.amount)*100),0)<c.amount;
 if(smaller){savePayments();saveContract();}else{saveContract();savePayments();}
 assert(Object.keys(fields).length>1||(b.payments||[]).length,'没有可更新内容');
 return {id:c.id,message:'合同与回款资料已统一保存，提成取数随最新销售归属更新'};
}
