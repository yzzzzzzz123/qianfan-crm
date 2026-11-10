import {all,one} from '../database.mjs';
import {assert,today} from '../domain.mjs';
import {performanceFor} from './incentives.mjs';
import {contractSplit,allocate} from '../sales-policy.mjs';
const snapshotOf=batch=>{try{const value=JSON.parse(batch.snapshot||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};
function inPeriod(day,period){
 if(!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day||''))return null;
 if(/^\d{4}$/.test(period))return day.slice(0,4)===period;
 if(/^\d{4}Q[1-4]$/.test(period))return `${day.slice(0,4)}Q${Math.ceil(Number(day.slice(5,7))/3)}`===period;
 if(/^\d{4}-(0[1-9]|1[0-2])$/.test(period))return day.startsWith(period);
 return null;
}
function currentBase(db,line,batch,snapshot){
 const c=one(db,'SELECT * FROM contracts WHERE id=?',line.contract_id),item=one(db,'SELECT * FROM contract_items WHERE id=?',line.item_id);
 if(!c||!item||c.retired_at||item.retired_at||c.lifecycle==='草稿')return {base:0,reason:'原合同或明细已删除／退出有效业务'};
 if(batch.kind==='personal'&&c.owner_id!==batch.sales_id)return {base:0,reason:'销售归属已变更'};
 if(batch.kind==='management'&&c.owner_id===batch.sales_id)return {base:0,reason:'归属变为本人，移出原团队管理范围'};
 if(!/^\d{4}(?:Q[1-4]|-(?:0[1-9]|1[0-2]))?$/.test(batch.period))return {base:null,reason:'原结算周期无效，待人工核对'};
 if(c.sign_date>today())return {base:0,reason:'当前签约日期晚于今天，尚未进入有效计提范围'};
 const signed=inPeriod(c.sign_date,batch.period);
 if(!['legacy','product','service'].includes(line.component))return {base:null,reason:'原计提组成缺失，待人工核对'};
 if(line.component==='service')return signed===null?{base:null,reason:'原周期或签约日期无效，待核对'}:{base:signed&&c.sign_date<=today()&&item.kind!=='标品'?item.amount:0,reason:signed?'按当前有效服务明细金额':'签约周期已变更'};
 if(line.component==='product'){
  const rows=all(db,'SELECT * FROM contract_items WHERE contract_id=? AND retired_at IS NULL',c.id),split=contractSplit(c,rows);if(!split.valid)return {base:null,reason:'产品／服务拆分待核对'};
  const allReceipts=all(db,"SELECT * FROM payments WHERE contract_id=? AND status='已到账'",c.id);
  if(allReceipts.some(p=>!p.pay_date))return {base:null,reason:'已有到账缺少日期，原周期分配待核对'};
  const receipts=allReceipts.filter(p=>inPeriod(p.pay_date,batch.period)&&p.pay_date<=today());let product=0;
  for(const p of receipts){if(p.product_amount!=null)product+=p.product_amount;else if(split.service===0)product+=p.amount;else if(split.product!==0)return {base:null,reason:'本期混合回款分配待补'};}
  const allocation=split.product?allocate(product,rows.filter(i=>i.kind==='标品')):[];return {base:allocation.find(i=>i.id===item.id)?.base||0,reason:'按本期现有实际回款分配'};
 }
 if(signed===null)return {base:null,reason:'原周期或签约日期无效，待核对'};
 if(!signed||c.sign_date>today())return {base:0,reason:'签约日期已移出原结算周期'};
 if(item.margin==null)return {base:null,reason:'当前扣费后毛利待核实'};
 let base=item.margin;if(snapshot.unlock_by_payment){if(c.amount<=0)return {base:null,reason:'合同金额无效，回款解锁比例待核对'};const paid=one(db,"SELECT COALESCE(SUM(amount),0) n FROM payments WHERE contract_id=? AND status='已到账'",c.id).n;base=Math.round(base*Math.min(1,paid/c.amount));}
 return {base,reason:'按当前扣费后毛利及原回款条件'};
}
export function readSettlementReview({db,getRules},actor,params=new URLSearchParams()){
 assert(actor.role==='admin','结算差额核对仅管理员可查看',403);const contractId=Number(params.get('contract_id'))||null,groups=new Map();
 for(const b of all(db,'SELECT b.*,u.name sales_name FROM commission_batches b LEFT JOIN users u ON u.id=b.sales_id ORDER BY b.id DESC')){const key=[b.sales_id,b.kind,b.period].join(':');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(b);}
 const records=[];
 for(const batches of groups.values()){
  const b=batches[0],ids=batches.map(v=>v.id),lines=all(db,`SELECT l.*,c.name contract_name,c.contract_no FROM commission_lines l LEFT JOIN contracts c ON c.id=l.contract_id WHERE l.batch_id IN(${ids.map(()=>'?').join(',')}) ORDER BY l.id`,...ids);
  // Multiple batches may repeat a line's full basis. Use its latest basis once,
  // while the confirmed cash remains the sum of all immutable batches.
  const unique=new Map();
  for(const original of [...batches].reverse()){
   // Zero-cent allocations are deliberately absent from commission_lines.
   // They still participated in cumulative rounding and remain in the locked
   // snapshot. Include that original scope, never newly added current items.
   const snapshot=snapshotOf(original);
   if(Array.isArray(snapshot.lines))for(const l of snapshot.lines){
    if(!Number.isSafeInteger(l.item_id)||!Number.isSafeInteger(l.contract_id))continue;
    const c=one(db,'SELECT name,contract_no FROM contracts WHERE id=?',l.contract_id),component=l.component||'legacy';
    unique.set([l.item_id,l.contract_id,component].join(':'),{...l,component,id:0,batch_id:original.id,contract_name:c?.name||l.contract_name,contract_no:c?.contract_no});
   }
   for(const l of lines.filter(l=>l.batch_id===original.id))unique.set([l.item_id,l.contract_id,l.component].join(':'),l);
  }
  if(contractId&&![...unique.values()].some(l=>l.contract_id===contractId))continue;
  let reference=0,pending=!lines.length;const details=[],rounding=new Map(),issues=lines.length?[]:['原结算缺少计提明细，不能据此认定当前应计为零'];
  for(const l of [...unique.values()].sort((a,b)=>a.item_id-b.item_id||a.id-b.id)){
   const original=batches.find(v=>v.id===l.batch_id),snapshot=snapshotOf(original),current=currentBase(db,l,original,snapshot);
   const validRate=typeof l.rate==='number'&&Number.isFinite(l.rate)&&l.rate>=0&&l.rate<=1;
   let amount=null,reason=current.reason;
   if(!validRate)reason='原结算提成比例缺失或无效，待人工核对';
   else if(current.base!=null){
    // Confirmation prices cumulative bases, not each line independently. Keep
    // the original component/rate and service grouping to preserve its cents.
    const scope=l.component==='service'&&snapshot.policy?.service_aggregation!=='month'?l.contract_id:'all';
    const key=[l.component,l.rate,scope].join(':'),group=rounding.get(key)||{base:0,allocated:0};
    group.base+=current.base;amount=Math.round(group.base*l.rate)-group.allocated;group.allocated+=amount;rounding.set(key,group);reference+=amount;
   }
   if(amount==null){pending=true;issues.push(reason);}
   details.push({contract_id:l.contract_id,contract_no:l.contract_no,contract_name:l.contract_name,item_id:l.item_id,component:l.component,original_base:l.base,current_base:current.base,rate:validRate?l.rate:null,reference_amount:amount,reason});
  }
  const confirmed=batches.reduce((s,x)=>s+x.amount,0),changed=details.some(l=>l.current_base!==l.original_base),difference=pending?null:reference-confirmed;
  records.push({type:'commission',sales_id:b.sales_id,sales_name:b.sales_name,kind:b.kind,period:b.period,batch_ids:ids,confirmed,reference:pending?null:reference,difference,changed:changed||difference!==null&&difference!==0,pending,issues:[...new Set(issues)],details,last_changed_at:lines.length?one(db,`SELECT MAX(created_at) t FROM audit WHERE entity='contract' AND entity_id IN(${[...new Set(lines.map(l=>l.contract_id))].map(()=>'?').join(',')})`,...[...new Set(lines.map(l=>l.contract_id))]).t:null});
 }
 const performance=[];for(const r of all(db,"SELECT r.*,u.name sales_name FROM performance_reviews r JOIN users u ON u.id=r.user_id WHERE r.status='confirmed' ORDER BY r.month DESC")){
  const snapshot=snapshotOf(r),user=one(db,'SELECT * FROM users WHERE id=?',r.user_id),current=performanceFor(db,getRules(),user,r.month,{recalculate:true});const oldIds=(snapshot.evidence?.contracts||[]).map(c=>c.id).sort((a,b)=>a-b),newIds=(current.evidence?.contracts||[]).map(c=>c.id).sort((a,b)=>a-b);if(contractId&&![...oldIds,...newIds].includes(contractId))continue;performance.push({review_id:r.id,sales_id:r.user_id,sales_name:r.sales_name,period:r.month,original_actual:snapshot.actual??null,current_actual:current.actual,original_score:snapshot.total??null,current_score:current.total,original_grade:snapshot.grade??null,current_grade:current.grade,changed:snapshot.actual!==current.actual||JSON.stringify(oldIds)!==JSON.stringify(newIds)||snapshot.total!==current.total||snapshot.grade!==current.grade,contract_ids:[...new Set([...oldIds,...newIds])]});
 }
 return {records,performance,basis:'原结算涉及的合同／明细，按原记录比例作现值参考；不包含后来新增的计提项目，不代表本次应补发或应追回金额。',confirmed_unchanged:true};
}
