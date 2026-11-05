// Read-only accounting review. This entry never confirms, pays, or modifies rules.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {commissionPreview} from '../server/modules/incentives.mjs';

const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
if(!args.includes('--database')||!args.includes('--month')||!args.includes('--output'))throw new Error('用法：node scripts/preview-commissions.mjs --database <现有SQLite> --month YYYY-MM --output <核对JSON>');
const filename=path.resolve(value('--database')),month=value('--month'),output=path.resolve(value('--output'));
if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!fs.existsSync(filename)||filename===output)throw new Error('核对月份、数据库或输出路径无效');
const db=new DatabaseSync(filename,{readOnly:true});
try{
 db.exec('PRAGMA query_only=ON; BEGIN');
 const actor=db.prepare("SELECT * FROM users WHERE role='admin' AND active=1 AND business_member=1 AND developer_admin=0 ORDER BY id LIMIT 1").get();
 if(!actor)throw new Error('缺少有效业务管理员，无法生成全员核对');
 const rules=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='rules'").get().value);
 const result=commissionPreview(db,rules,actor,month);
 const report={...result,generated_at:new Date().toISOString(),mode:'read_only_trial',month,confirmation_performed:false,payment_performed:false,rule_effective_month:rules.commission.sales_policy?.effective_month,notes:['产品按实际产品到账选档；服务按现有SOP合同服务金额选档。','规则生效前月份仅补算试算。缺绩效、缺归属、缺分配及未确认服务范围保留待核对。','管理者个人及团队继续使用已确认的原累计毛利规则，不将新合同猜设为历史计提。']};
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));
 db.exec('COMMIT');
 console.log(JSON.stringify({month,mode:report.mode,receipt_count:report.receipt_review.length,receipt_amount:report.receipt_review.reduce((s,p)=>s+p.amount,0),previews:report.previews.map(p=>({name:p.name,kind:p.kind,period:p.period,base:p.base,components:p.components,grade:p.grade,total:p.amount_pending?null:p.total,blocked:p.blocked,issues:p.issues,scenarios:p.scenarios})),output},null,2));
}finally{db.close();}
