import {createHash} from 'node:crypto';
import {all,one} from '../database.mjs';
import {today} from '../domain.mjs';
import {allocate,bandFor,contractSplit} from '../sales-policy.mjs';
import {commissionInputs} from './commission-inputs.mjs';

export function salesCommissionPreviews(db,rules,actor,month,performanceFor) {
  const policy=rules.commission.sales_policy;
  const users=all(db,"SELECT * FROM users WHERE role='sales' AND active=1 AND business_member=1 AND developer_admin=0");
  const contracts=all(db,"SELECT * FROM contracts WHERE retired_at IS NULL AND lifecycle!='草稿' AND sign_date<=? ORDER BY id",today());
  const items=all(db,'SELECT * FROM contract_items ORDER BY id');
  const receipts=all(db,"SELECT * FROM payments WHERE status='已到账' ORDER BY pay_date,id");
  const inputs=commissionInputs(db,month);
  const batches=all(db,"SELECT * FROM commission_batches WHERE kind='personal' AND period=?",month);
  const lockedLines=all(db,"SELECT l.*,b.sales_id FROM commission_lines l JOIN commission_batches b ON b.id=l.batch_id WHERE b.kind='personal' AND b.period=?",month);
  const legacySettled=new Set(all(db,"SELECT DISTINCT contract_id FROM commission_lines l JOIN commission_batches b ON b.id=l.batch_id WHERE b.kind='personal' AND l.component='legacy'").map(l=>l.contract_id));
  return users.filter(u=>actor.role==='admin'||actor.role==='sales'&&actor.id===u.id).map(user=>{
    const performance=performanceFor(db,rules,user,month),grade=performance.grade;
    const issues=[],productBases=[],serviceBases=[],evidence=[];
    const owned=contracts.filter(c=>c.owner_id===user.id);
    for(const contract of owned) {
      const split=inputs.split(contract);
      const claims=inputs.claims.filter(p=>p.contract_id===contract.id);
      const paid=[...receipts.filter(p=>p.contract_id===contract.id&&p.pay_date?.startsWith(month)&&p.pay_date<=today()),...claims.map(p=>({...p,id:null,pay_date:p.date,product_amount:p.product_amount,source_claim:true}))];
      for(const claim of claims)issues.push(`${contract.name}：${claim.reason}`);
      if(split.source_basis&&(contract.sign_date.startsWith(month)||paid.length))issues.push(`${contract.name}：合同拆分取自已核验来源字段，明细尚待补齐，仅供试算`);
      if(legacySettled.has(contract.id)&&(contract.sign_date.startsWith(month)||paid.length)) {issues.push(`${contract.name}：已有历史个人提成，请核对后再切换新算法，避免重复计提`);continue;}
      if(!split.valid) {
        if(contract.sign_date.startsWith(month)||paid.length)issues.push(`${contract.name}：${split.reason}`);
        continue;
      }
      const decorate=i=>({...i,contract_name:contract.name,owner_id:user.id});
      if(contract.sign_date.startsWith(month))serviceBases.push(...split.items.filter(i=>i.kind!=='标品').map(i=>({...decorate(i),base:i.amount,component:'service',contract_service:split.service})));
      let productReceived=0;
      for(const payment of paid) {
        let product=payment.product_amount;
        if(product==null) {
          if(split.product===0)product=0;
          else if(split.service===0)product=payment.amount;
          else {issues.push(`${contract.name}：到账 ${payment.pay_date} 的产品回款分配未填写`);continue;}
        }
        const prior=receipts.filter(p=>p.contract_id===contract.id&&p.pay_date&&p.pay_date<=today());
        // Across all dated receipts an explicit split must not exceed either contract component.
        const known=prior.filter(p=>p.product_amount!=null);
        if(known.reduce((s,p)=>s+p.product_amount,0)>split.product||known.reduce((s,p)=>s+p.amount-p.product_amount,0)>split.service) {
          issues.push(`${contract.name}：累计产品或服务回款超过合同对应金额`);continue;
        }
        productReceived+=product;
        evidence.push({payment_id:payment.id,contract_id:contract.id,contract_name:contract.name,date:payment.pay_date,amount:payment.amount,product_amount:product,...(payment.source_claim?{source_claim:true,source_record_id:payment.source_record_id}:{})});
      }
      if(productReceived>0)productBases.push(...allocate(productReceived,split.items.filter(i=>i.kind==='标品')).map(i=>({...decorate(i),base:i.base,component:'product'})));
      if(receipts.some(p=>p.contract_id===contract.id&&!p.pay_date&&p.created_at.startsWith(month)))issues.push(`${contract.name}：已到账记录缺少到账日期`);
    }
    const productBase=productBases.reduce((s,i)=>s+i.base,0),serviceBase=serviceBases.reduce((s,i)=>s+i.base,0);
    if(serviceBase>0&&!policy.service_scope_confirmed)issues.push('项目服务按单合同还是当月合计选档尚待确认，当前按单合同口径试算');
    if(productBase+serviceBase>0) {
      if(!grade)issues.push('当月绩效等级尚未确定');
      if(performance.status!=='confirmed')issues.push('当月绩效尚未确认锁定，当前仅供试算');
    }
    const productBand=bandFor(policy.product,productBase),productRate=productBase===0?0:productBand.rates[grade]??null;
    if(productBase>0&&grade&&productRate===null)issues.push(`产品回款 ${productBand.min/10000/100} 万元起档的 ${grade} 级比例待核实`);
    const serviceGroups=new Map();
    for(const line of serviceBases) {
      const key=policy.service_aggregation==='month'?'month':line.contract_id;
      if(!serviceGroups.has(key))serviceGroups.set(key,[]);
      serviceGroups.get(key).push(line);
    }
    let productTotal=0,serviceTotal=0;
    const lines=[];
    function price(rows,rate,component) {
      let base=0,allocated=0;
      for(const i of rows) {
        base+=i.base;const entitlement=rate===null?0:Math.round(base*rate)-allocated;allocated+=entitlement;
        const prior=lockedLines.filter(l=>l.sales_id===user.id&&l.component===component&&l.item_id===i.id).reduce((s,l)=>s+l.amount,0);
        lines.push({item_id:i.id,contract_id:i.contract_id,contract_name:i.contract_name,owner_id:user.id,kind:i.kind,product:i.name,component,base:i.base,rebate_rate:i.rate,rate,entitlement,amount:entitlement-prior});
      }
      return allocated;
    }
    productTotal=price(productBases,productRate,'product');
    for(const group of serviceGroups.values()) {
      const base=group.reduce((s,i)=>s+i.base,0),rate=bandFor(policy.service,base).rates[grade]??null;
      if(grade&&rate===null)issues.push(`项目服务 ${bandFor(policy.service,base).min/10000/100} 万元起档的 ${grade} 级比例待核实`);
      serviceTotal+=price(group,rate,'service');
    }
    const locked=batches.filter(b=>b.sales_id===user.id),confirmed=locked.reduce((s,b)=>s+b.amount,0);
    if(locked.some(b=>JSON.parse(b.snapshot).scheme!==policy.version))issues.push('同月已有其他算法的结算，须先核对历史快照');
    const total=productTotal+serviceTotal,due=total-confirmed;
    if(due<0||lines.some(l=>l.amount<0))issues.push('当前应计低于已确认金额，请核对差额');
    const components=[{type:'product',label:'产品',basis:evidence.some(p=>p.source_claim)?'当月产品回款（含待核对合同记录）':'当月产品实际回款',base:productBase,rate:productRate,total:productTotal},
      {type:'service',label:'项目／服务',basis:policy.service_aggregation==='contract'?'每份合同的项目／服务金额选档':'当月项目／服务合同金额合计选档',base:serviceBase,rate:serviceGroups.size===1?lines.find(l=>l.component==='service')?.rate??0:null,total:serviceTotal}];
    const input={sales_id:user.id,kind:'personal',period:month,scheme:policy.version,policy,grade,performance_status:performance.status,review_id:performance.review_id,components,lines,evidence,confirmed,issues:[...new Set(issues)]};
    const scenarios=['D','C','B','A'].map(g=>{const pr=productBase?productBand.rates[g]:0;const services=[...serviceGroups.values()].map(group=>{const base=group.reduce((s,i)=>s+i.base,0),rate=bandFor(policy.service,base).rates[g];return rate==null?null:Math.round(base*rate);});return {grade:g,product:pr==null?null:Math.round(productBase*pr),service:services.some(v=>v==null)?null:services.reduce((s,v)=>s+v,0)};});
    return {...input,name:user.name,base:productBase+serviceBase,rate:productBase+serviceBase?total/(productBase+serviceBase):0,total,confirmed,paid:locked.filter(b=>b.status==='paid').reduce((s,b)=>s+b.amount,0),due,blocked:issues.length>0,scenarios,amount_pending:productBase+serviceBase>0&&(!grade||lines.some(l=>l.rate==null)),fingerprint:createHash('sha256').update(JSON.stringify(input)).digest('hex')};
  });
}
