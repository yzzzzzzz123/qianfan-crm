import {createHash} from 'node:crypto';
import {all,one} from '../database.mjs';
import {assert,text} from '../domain.mjs';
import {ledgerPayments} from '../collection-ledger.mjs';
import {contractFinancials} from './reporting-prd.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function reviewContract(db,id){
 const c=one(db,'SELECT c.*,u.name owner_name,cu.name customer_name FROM contracts c LEFT JOIN users u ON u.id=c.owner_id LEFT JOIN customers cu ON cu.id=c.customer_id WHERE c.id=?',Number(id));assert(c,'合同不存在',404);
 const items=all(db,'SELECT * FROM contract_items WHERE contract_id=? AND retired_at IS NULL ORDER BY id',c.id),payments=ledgerPayments(db,c.id),collected=payments.filter(p=>p.status==='已到账').reduce((s,p)=>s+p.amount,0),planned=payments.filter(p=>p.record_type==='plan').reduce((s,p)=>s+p.remaining_amount,0);
 const financials=contractFinancials(c,items),issues=[];
 if(!c.contract_no)issues.push('合同编号待补');if(!c.owner_id)issues.push('销售归属待补');if(!financials.financials_complete)issues.push('明细分类或合计与合同不一致');if(financials.total_margin==null)issues.push('毛利待核实');if(payments.some(p=>p.status==='已到账'&&p.product_amount==null&&financials.product_amount>0&&financials.service_amount>0))issues.push('混合回款产品分配待补');if(planned>c.amount-collected)issues.push('收款计划余款超过合同未收');if(collected>c.amount)issues.push('实收超过合同金额');if(payments.some(p=>p.status==='已到账'&&!p.pay_date))issues.push('实际到账日期缺失');
 const sources=all(db,"SELECT id,source,source_table,source_file,sheet_name,row_number,payload,reason FROM source_records WHERE entity='contract' AND entity_id=? ORDER BY id DESC LIMIT 20",c.id).map(({payload,...s})=>{let raw={};try{raw=JSON.parse(payload)}catch{}return {...s,values:raw.values||raw.contract||raw};});
 return {...c,...financials,items,payments,collected,outstanding:c.amount-collected,planned_remaining:planned,issues,sources};
}
export function readDataReview({db},actor,params=new URLSearchParams()){
 assert(actor.role==='admin','迁移核对仅管理员可查看',403);const id=params.get('contract_id'),q=(params.get('q')||'').trim().toLowerCase();
 const ids=all(db,'SELECT id FROM contracts WHERE retired_at IS NULL ORDER BY id DESC');const records=ids.map(c=>reviewContract(db,c.id)).filter(c=>!q||[c.contract_no,c.name,c.customer_name,c.owner_name].join(' ').toLowerCase().includes(q));
 const selected=id?records.find(c=>c.id===Number(id)):null;
 return {records:records.map(({sources,items,payments,...c})=>c),selected:selected||null,detail:id?reviewContract(db,Number(id)):null,revision:one(db,'SELECT revision FROM workspace_revision WHERE id=1').revision};
}
function validate(b){assert(Array.isArray(b.changes)&&b.changes.length>0&&b.changes.length<=50,'请选择1至50份合同修正');const seen=new Set();for(const c of b.changes){assert(c&&typeof c==='object'&&Object.keys(c).every(k=>['contract_id','fields','items','payments'].includes(k)),'修正清单包含不支持内容');assert(Number.isSafeInteger(c.contract_id)&&c.contract_id>0&&!seen.has(c.contract_id),'合同编号无效或重复');seen.add(c.contract_id);assert(c.fields&&typeof c.fields==='object'&&!Array.isArray(c.fields),'合同字段格式无效');}return text(b.reason,'统一修正依据',1000);}
function fingerprint(db,b){return hash({revision:one(db,'SELECT revision FROM workspace_revision WHERE id=1').revision,changes:b.changes,reason:b.reason});}
function applyChanges(ctx,b,reason){const results=[];for(const c of b.changes){const before=reviewContract(ctx.db,c.contract_id);assert(!before.retired_at,'请先恢复已删除合同',409);ctx.mutate(`/api/contracts/${c.contract_id}/maintenance`,'PATCH',{fields:c.fields,...(c.items?{items:c.items}:{}),...(c.payments?{payments:c.payments}:{}),reason,data_correction:true},ctx.actor);const after=reviewContract(ctx.db,c.contract_id);results.push({contract_id:c.contract_id,contract_no:after.contract_no,name:after.name,before:summary(before),after:summary(after),field_changes:Object.keys(c.fields).filter(k=>before[k]!==after[k]).map(field=>({field,before:field==='owner_id'?before.owner_name:field==='customer_id'?before.customer_name:before[field],after:field==='owner_id'?after.owner_name:field==='customer_id'?after.customer_name:after[field]})),item_changes:c.items?changedRecords(before.items,after.items,['name','kind','amount','margin_before_expense','business_expense','margin']):[],payment_changes:c.payments?changedRecords(before.payments,after.payments,['contract_id','amount','status','pay_date','promise_date','checkpoint_date','product_amount','reference_no','note']):[],issues_after:after.issues});}return results;}
function changedRecords(before,after,keys){const old=new Map(before.map(r=>[r.id,r])),next=new Map(after.map(r=>[r.id,r]));return [...new Set([...old.keys(),...next.keys()])].filter(id=>!old.has(id)||!next.has(id)||keys.some(k=>old.get(id)[k]!==next.get(id)[k])).map(id=>({id,before:old.has(id)?Object.fromEntries(keys.map(k=>[k,old.get(id)[k]])):null,after:next.has(id)?Object.fromEntries(keys.map(k=>[k,next.get(id)[k]])):null}));}
const summary=c=>({amount:c.amount,collected:c.collected,outstanding:c.outstanding,planned_remaining:c.planned_remaining,total_margin:c.total_margin,business_expense:c.business_expense,owner_name:c.owner_name,customer_name:c.customer_name});
export function handleDataReview(ctx){
 if(!['/api/data-review/preview','/api/data-review/apply'].includes(ctx.path)||ctx.method!=='POST')return;
 ctx.admin(ctx.actor);const reason=validate(ctx.b),token=fingerprint(ctx.db,ctx.b);
 if(ctx.path.endsWith('/preview')){
  ctx.db.exec('SAVEPOINT data_review_preview');try{const results=applyChanges(ctx,ctx.b,reason);ctx.db.exec('ROLLBACK TO data_review_preview;RELEASE data_review_preview');return {fingerprint:token,results,message:'预览未写入业务数据，请核对后确认提交'};}catch(e){ctx.db.exec('ROLLBACK TO data_review_preview;RELEASE data_review_preview');throw e;}
 }
 assert(ctx.b.fingerprint===token,'业务资料已变化，请重新预览后提交',409);const results=applyChanges(ctx,ctx.b,reason);ctx.audit(ctx.actor,'批量迁移修正','contract',null,{reason,contract_ids:ctx.b.changes.map(c=>c.contract_id),results});return {results,message:'修正清单已全部保存；历史确认结算保留，影响可到结算差额核对查看'};
}
