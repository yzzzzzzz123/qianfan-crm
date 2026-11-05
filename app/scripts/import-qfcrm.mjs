import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openDatabase,transaction} from '../server/database.mjs';
import {normalize} from '../server/domain.mjs';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const hash=value=>createHash('sha256').update(value).digest('hex');
const text=value=>value===null||value===undefined?'':String(value).trim();
const empty=value=>text(value)==='';
const aliases=new Map([['暮雪','米粒'],['米粒（王德丽）','米粒']]);
const protectedNames=new Set(['余志政','孙笑天','杨丽莉']);
const stages=new Map([['线索阶段','线索'],['需求阶段','需求'],['方案阶段','方案'],['商务阶段','商务'],...['线索','需求','方案','商务','赢单','输单','搁置'].map(x=>[x,x])]);
const saleTypes=new Map([['新签（自建）','新签自建'],['新签(自建)','新签自建'],['新签（分发）','新签分发'],['新签(分发)','新签分发'],...['新签自建','新签分发','续费','增购'].map(x=>[x,x])]);
const orderTypes=new Set(['代销','经销','千帆']),itemKinds=new Set(['标品','实施','定开','交付','运维']);
const mimeTypes={'.pdf':'application/pdf','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.doc':'application/msword','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'};

export const importRequirements=Object.freeze({
  customer:['客户名称','唯一原销售证据对应的现有在用业务负责人'],
  contact:['已准入客户','联系人姓名','原文明确电话/微信/钉钉至少一项'],
  opportunity:['本年创建/更新/预计到单','商机编号','已准入客户','售卖产品','现有在用销售','7阶段','非负合同金额','明确cash金额（允许原文为0且不超过合同金额）','销售分类','订单类型'],
  contract:['合同编号','已准入客户','现有在用销售','合同名称/售卖产品','真实签订日','正合同金额','合计一致的明确名称/类型/金额明细'],
  payment:['已准入合同的明确编号','客户一致','已收/未收与计划总额一致','实际收款有实际日','未收计划有承诺日','同合同计划合计不超额'],
  activity:['本年真实发生日','已准入商机唯一关联','现有在用记录人','明确跟进内容'],
  attachment:['业务已准入','原附件引用或精确合同号','来源路径及SHA256核验'],
  excluded:'缺项、冲突和范围外原件仅留包外清单，不建占位记录或正式待完善原始表行。',
});
export function parseSourceMoney(value) {
  if(empty(value))return null;
  const s=text(value).replace(/[¥￥,\s]/g,'').replace(/元$/,'');if(!/^-?\d+(?:\.\d{1,2})?$/.test(s))return null;
  const negative=s.startsWith('-'),[whole,part='']=s.replace(/^-/,'').split('.'),cents=BigInt(whole)*100n+BigInt(part.padEnd(2,'0'));
  return cents>BigInt(Number.MAX_SAFE_INTEGER)?null:Number(negative?-cents:cents);
}
const date=value=>{const s=text(value).slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;const d=new Date(s+'T12:00:00Z');return Number.isFinite(d.valueOf())&&d.toISOString().slice(0,10)===s?s:null;};
const timestamp=(v,fallback)=>!date(v)?fallback:/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text(v))?text(v).replace(' ','T')+'+08:00':text(v);
function contactFields(d) {
  const name=text(d['联系人姓名']),method=text(d['联系方式']);let phone=text(d['联系电话']),wechat='',dingtalk='';
  if(!phone&&/^\+?[\d()（） -]{5,}$/.test(method))phone=method;
  if(/^微信[:：]/.test(method))wechat=method.replace(/^微信[:：]\s*/,'');if(/^钉钉[:：]/.test(method))dingtalk=method.replace(/^钉钉[:：]\s*/,'');
  return {name,method,phone,wechat,dingtalk,incomplete:!!(name||phone||method)&&!(name&&(phone||wechat||dingtalk))};
}
function checkedDatabase(filename) {
  if(!filename||filename===':memory:')throw new Error('必须显式指定隔离 --database 文件');
  const resolved=path.resolve(filename),formal=path.resolve(appRoot,'data');let real=resolved;
  if(fs.existsSync(resolved))real=fs.realpathSync(resolved);
  else {let parent=path.dirname(resolved);while(!fs.existsSync(parent))parent=path.dirname(parent);real=path.join(fs.realpathSync(parent),path.relative(parent,resolved));}
  if(real.toLowerCase()===formal.toLowerCase()||real.toLowerCase().startsWith(formal.toLowerCase()+path.sep))throw new Error('导入器禁止直接修改正式 app/data；请使用备份隔离库');return resolved;
}
function confined(root,relative) {
  if(path.isAbsolute(relative)||relative.split(/[\\/]/).some(x=>x==='..')||relative.includes(':'))throw new Error('来源附件路径不安全');
  const resolved=fs.realpathSync(path.resolve(root,relative)),base=fs.realpathSync(root);
  const within=path.relative(base,resolved);
  if(within==='..'||within.startsWith('..'+path.sep)||path.isAbsolute(within))throw new Error('来源附件超出资料目录');return resolved;
}

function readAdmittedPackage(filename,{extraction,source,manifest,workbook,year}) {
  if(!filename)return null;
  const base=path.dirname(fs.realpathSync(filename)),pack=JSON.parse(fs.readFileSync(filename,'utf8'));
  if(!['qfcrm-admitted-v1','qfcrm-admitted-historical-v1'].includes(pack.format)||pack.year!==year||pack.source?.file!==workbook.file||pack.source?.sha256!==workbook.sha256)throw new Error('准入包格式、年份或原文件校验值不一致');
  if(pack.format==='qfcrm-admitted-historical-v1'&&!Array.isArray(pack.grandfathered_missing_fields)||pack.format==='qfcrm-admitted-v1'&&pack.grandfathered_missing_fields?.length)throw new Error('历史缺项白名单只允许明确的历史准入包');
  for(const [supplied,relative] of [[extraction,'extraction'],[source,'source'],[manifest,'manifest.json']])if(fs.realpathSync(supplied)!==fs.realpathSync(path.join(base,relative)))throw new Error('准入包必须使用同包内的提取资料、附件和清单');
  if(!Array.isArray(pack.files)||!Array.isArray(pack.admitted_rows)||!Array.isArray(pack.customer_owner_evidence)||!pack.expected)throw new Error('准入包缺少验收清单');
  const entries=new Set();for(const file of pack.files){
    if(typeof file.path!=='string'||file.path.includes('\\')||entries.has(file.path)||!Number.isSafeInteger(file.size)||file.size<0)throw new Error('准入包文件清单无效或重复');entries.add(file.path);
    const content=fs.readFileSync(confined(base,file.path));if(content.length!==file.size||hash(content)!==file.sha256)throw new Error('准入包文件校验失败');
  }
  const attachments=JSON.parse(fs.readFileSync(manifest,'utf8')).files;
  const expectedFiles=new Set(['extraction/QFCRM.rows.json','manifest.json',...attachments.map(f=>'source/'+f.relative_path)]);
  if(entries.size!==expectedFiles.size||[...entries].some(p=>!expectedFiles.has(p)))throw new Error('准入包包含非准入文件或缺少文件');
  return pack;
}

/** Only records satisfying current business requirements enter the database. */
export function importQfcrm({database,extraction,source,manifest:manifestPath,admitted:admittedPath,year=2026,includeAttachments=true,now=new Date().toISOString()}) {
  database=checkedDatabase(database);
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')),workbook=JSON.parse(fs.readFileSync(path.join(extraction,'QFCRM.rows.json'),'utf8'));
  const admitted=readAdmittedPackage(admittedPath,{extraction,source,manifest:manifestPath,workbook,year});
  if(admitted&&!includeAttachments)throw new Error('准入包必须完整核验附件');
  const tables=new Map(workbook.sheets.map(s=>[s.name,s.rows.slice(1).map(r=>({file:workbook.file,sheet:s.name,row:r.row,data:Object.fromEntries(s.rows[0].values.map((h,i)=>[h,r.values[i]??null])),metadata:r.cell_metadata||{}}))]));
  const get=name=>tables.get(name)||[],db=openDatabase(database);
  const one=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args);
  const insert=(table,data)=>Number(db.prepare(`INSERT INTO ${table} (${Object.keys(data).join(',')}) VALUES(${Object.keys(data).map(()=>'?').join(',')})`).run(...Object.values(data)).lastInsertRowid);
  const report={database,year,source:workbook.file,imported_at:now,requirements:importRequirements,created:{},rows:{},skipped_idempotent:0,attachments:{files:0,bytes:0},excluded:[],excluded_files:[],integrity:null};
  if(admitted?.format==='qfcrm-admitted-historical-v1')report.requirements={...importRequirements,historical_exception:'仅冻结的已入库历史来源白名单保留真实缺失cash；不删历史、不补0，新建及普通资料导入仍须明确cash。'};
  const inc=table=>report.created[table]=(report.created[table]||0)+1;
  const customerMap=new Map(),contractMap=new Map(),opportunityMap=new Map(),ownerEvidence=new Map(),grandfatheredCash=new Set();
  const fingerprint=r=>hash(JSON.stringify({source:'QFCRM',file:r.file,sheet:r.sheet,row:r.row,data:r.data}));
  const sourceId=r=>text(r.data['商机编号']||r.data['合同编号']||r.data['拜访编号']||r.data['产品名称'])||String(r.row);
  function existing(r) {const row=one('SELECT * FROM source_records WHERE fingerprint=?',fingerprint(r));if(row)report.skipped_idempotent++;return row;}
  function record(r,{entity,id=null,related=[]}) {
    const sid=insert('source_records',{source:'QFCRM',source_table:r.sheet,source_id:sourceId(r),entity,entity_id:id,payload:JSON.stringify({values:r.data,cell_metadata:r.metadata,source_sha256:workbook.sha256,related}),source_file:r.file,sheet_name:r.sheet,row_number:r.row,imported_at:now,fingerprint:fingerprint(r),status:'imported',reason:''});
    inc('source_records');const stat=report.rows[r.sheet]??={imported:0,excluded:0};stat.imported++;return sid;
  }
  function exclude(r,reasons,kind='row') {
    const reason=Array.isArray(reasons)?reasons.filter(Boolean).join('；'):reasons;
    report.excluded.push({file:r.file,sheet:r.sheet,row:r.row,source_id:sourceId(r),kind,reason,values:r.data});const stat=report.rows[r.sheet]??={imported:0,excluded:0};stat.excluded++;
  }
  function owner(value) {
    const name=aliases.get(text(value))||text(value);if(!name||protectedNames.has(name))return null;
    const users=all('SELECT id FROM users WHERE name=? AND active=1 AND business_member=1 AND developer_admin=0',name);return users.length===1?users[0].id:null;
  }
  function admittedOwners() {
    if(!admitted)return;
    const actual=new Map(),declared=new Map();
    for(const rows of tables.values())for(const r of rows){const key=JSON.stringify([r.file,r.sheet,r.row]);if(actual.has(key))throw new Error('准入包原始行重复');actual.set(key,r);}
    for(const item of admitted.admitted_rows){const key=JSON.stringify([item.source_file,item.sheet_name,item.row_number]),r=actual.get(key);if(declared.has(key)||!r||item.fingerprint!==fingerprint(r))throw new Error('准入包行号或来源指纹不一致');declared.set(key,item);}
    if(actual.size!==declared.size)throw new Error('准入包混入未验收原始行');
    for(const exception of admitted.grandfathered_missing_fields||[]){
      const key=JSON.stringify([exception.source_file,exception.sheet_name,exception.row_number]),r=actual.get(key),record=declared.get(key);
      if(admitted.format!=='qfcrm-admitted-historical-v1'||exception.field!=='product_amount'||!r||r.sheet!=='PPL总表'||record?.entity!=='opportunity'||exception.fingerprint!==fingerprint(r)||!empty(r.data['cash金额'])||grandfatheredCash.has(exception.fingerprint))throw new Error('历史cash缺项白名单被篡改或不对应已验收原行');
      grandfatheredCash.add(exception.fingerprint);
    }
    for(const r of get('PPL总表')){const cash=parseSourceMoney(r.data['cash金额']),total=parseSourceMoney(r.data['合同金额']),historical=grandfatheredCash.has(fingerprint(r));if((cash===null&&!historical)||cash!==null&&(cash<0||cash>total)||total===null)throw new Error('准入包商机缺明确有效cash金额或历史缺项白名单，不推定为0');}
    const owners=new Set(),customerRows=new Set();
    for(const item of admitted.customer_owner_evidence){
      const name=normalize(text(item.customer_name)),expectedName=aliases.get(text(item.owner_name))||text(item.owner_name);
      if(!name||name!==item.normalized||owners.has(name)||!owner(expectedName)||!Array.isArray(item.source_rows)||!item.source_rows.length||!Array.isArray(item.evidence)||!item.evidence.length)throw new Error('准入包负责人非唯一在用业务成员或缺客户原行');
      owners.add(name);const names=new Set(),proofRows=new Set();
      for(const proof of item.evidence){const key=JSON.stringify([proof.sheet,proof.row]);if(!['PPL总表','合同总表'].includes(proof.sheet)||!Number.isSafeInteger(proof.row)||proof.row<2||normalize(text(proof.customer_name))!==name||proofRows.has(key)||!text(proof.sales_name))throw new Error('准入包销售证据行无效');proofRows.add(key);names.add(aliases.get(text(proof.sales_name))||text(proof.sales_name));}
      if(names.size!==1||!names.has(expectedName))throw new Error('准入包销售证据不唯一或与负责人不符');
      const cropped=ownerEvidence.get(name);if(cropped&&[...cropped].some(n=>n!==expectedName))throw new Error('准入包负责人证据与业务原行不一致');
      for(const ref of item.source_rows){const key=JSON.stringify([workbook.file,ref.sheet,ref.row]),r=actual.get(key);if(customerRows.has(key)||ref.sheet!=='客户-基础表'||!r||normalize(text(r.data['客户']))!==name||ref.fingerprint!==fingerprint(r)||declared.get(key)?.entity!=='customer')throw new Error('准入包客户原行与负责人证据未一一对应');customerRows.add(key);}
      ownerEvidence.set(name,new Set([expectedName]));
    }
    if(customerRows.size!==get('客户-基础表').length)throw new Error('准入包客户负责人证据不完整');
  }
  function verifyAdmittedResult() {
    if(!admitted)return;
    if(report.excluded.some(r=>r.kind==='row')||report.excluded_files.length)throw new Error('准入包与服务器现有业务冲突或必填校验失败，整批回滚');
    const entityTables={customer:'customers',contact:'contacts',opportunity:'opportunities',contract:'contracts',contract_item:'contract_items',payment:'payments',activity:'activities',attachment:'attachments'},ids=new Map(Object.keys(entityTables).map(k=>[k,new Set()]));
    function check(entity,id){const table=entityTables[entity];if(!table||!Number.isSafeInteger(id)||!one(`SELECT id FROM ${table} WHERE id=?`,id))throw new Error('准入包已存在来源的业务对象缺失');ids.get(entity).add(id);}
    const fingerprints=[...admitted.admitted_rows.map(r=>r.fingerprint),...manifest.files.map(f=>hash('QFCRM:attachment:'+f.relative_path+':'+f.sha256))];
    if(new Set(fingerprints).size!==fingerprints.length||fingerprints.length!==admitted.expected.source_records)throw new Error('准入包来源总数不一致');
    for(const fp of fingerprints){const r=one('SELECT * FROM source_records WHERE fingerprint=?',fp);if(!r||r.status!=='imported')throw new Error('准入包来源未完整入库');check(r.entity,r.entity_id);const payload=JSON.parse(r.payload);for(const related of payload.related||[])check(related.entity,related.id);if(r.entity==='opportunity'){const cash=parseSourceMoney(payload.values?.['cash金额']),current=one('SELECT product_amount,amount FROM opportunities WHERE id=?',r.entity_id),historical=grandfatheredCash.has(fp);if((cash===null&&!historical)||cash!==null&&(cash<0||cash>current.amount)||cash!==current.product_amount)throw new Error('准入包商机cash金额与验收来源不一致');}}
    for(const [entity,table] of Object.entries(entityTables))if(ids.get(entity).size!==admitted.expected.business?.[table])throw new Error('准入包业务计数不一致');
    for(const entity of ['customer','opportunity','contract'])for(const id of ids.get(entity)){const row=one(`SELECT * FROM ${entityTables[entity]} WHERE id=?`,id),user=one('SELECT name FROM users WHERE id=?',row.owner_id);if(!user||owner(user.name)!==row.owner_id)throw new Error('准入包对象负责人当前无业务权限');}
    for(const proof of admitted.customer_owner_evidence){const row=one('SELECT id,owner_id FROM customers WHERE normalized=?',proof.normalized);if(!row||!ids.get('customer').has(row.id)||row.owner_id!==owner(proof.owner_name))throw new Error('准入包客户当前负责人已变化，不覆盖服务器业务归属');}
    const sum=(entity,predicate=()=>true)=>[...ids.get(entity)].map(id=>one(`SELECT * FROM ${entityTables[entity]} WHERE id=?`,id)).filter(predicate).reduce((n,r)=>n+r.amount,0);
    const amounts={opportunities:sum('opportunity'),contracts:sum('contract'),contract_items:sum('contract_item'),received:sum('payment',r=>r.status==='已到账'),planned:sum('payment',r=>r.status!=='已到账')};
    if(Object.entries(amounts).some(([key,value])=>admitted.expected.amounts_cents?.[key]!==value))throw new Error('准入包业务金额与验收值不一致');
    report.admitted_verified={rows:admitted.admitted_rows.length,source_records:fingerprints.length,business:admitted.expected.business,amounts_cents:amounts,grandfathered_missing_cash:grandfatheredCash.size};
  }
  const customerId=value=>customerMap.get(normalize(text(value)))??one('SELECT id FROM customers WHERE normalized=?',normalize(text(value)))?.id??null;
  function customer(r) {
    const d=r.data,name=text(d['客户']),prior=existing(r);if(prior){customerMap.set(normalize(name),prior.entity_id);if(contactFields(d).incomplete)exclude(r,'联系人缺姓名或明确电话/微信/钉钉；客户可独立准入','contact');return;}
    const evidence=ownerEvidence.get(normalize(name))||new Set(),uid=evidence.size===1?owner([...evidence][0]):null,old=one('SELECT * FROM customers WHERE normalized=?',normalize(name));
    if(!name||!uid)return exclude(r,!name?'客户名称缺失':'客户缺唯一在用业务销售归属；创建人不当作负责人');
    if(old&&old.owner_id!==uid)return exclude(r,'原销售归属与已有客户不一致，未覆盖');
    const id=old?.id||insert('customers',{name,normalized:normalize(name),owner_id:uid,created_at:now,updated_at:now});if(!old)inc('customers');customerMap.set(normalize(name),id);
    const related=[],{name:cname,method,phone,wechat,dingtalk}=contactFields(d);
    if(cname&&(phone||wechat||dingtalk)){
      const oldContact=one('SELECT id FROM contacts WHERE customer_id=? AND name=? AND phone=? AND wechat=? AND dingtalk=?',id,cname,phone,wechat,dingtalk);
      const cid=oldContact?.id||insert('contacts',{customer_id:id,name:cname,title:text(d['对接人职位']),phone,wechat,dingtalk,note:method});if(!oldContact)inc('contacts');related.push({entity:'contact',id:cid});
    }else if(cname||phone||method)exclude(r,'联系人缺姓名或明确电话/微信/钉钉；客户可独立准入','contact');
    record(r,{entity:'customer',id,related});
  }
  function opportunity(r) {
    const d=r.data,ref=text(d['商机编号']),prior=existing(r);if(prior){opportunityMap.set(ref,prior.entity_id);return;}
    if(!['创建时间','最后更新时间','预计到单时间'].some(k=>date(d[k])?.startsWith(String(year)+'-')))return exclude(r,`不在${year}年活跃商机范围`);
    const cid=customerId(d['客户名称']),uid=owner(d['销售小二']),name=text(d['售卖产品']),amount=parseSourceMoney(d['合同金额']),stage=stages.get(text(d['商机阶段'])),sale=saleTypes.get(text(d['产品类型'])),order=orderTypes.has(text(d['订单类型']))?text(d['订单类型']):null,prod=parseSourceMoney(d['cash金额']);
    const historicalCashMissing=grandfatheredCash.has(fingerprint(r));
    const errors=[!ref&&'缺商机编号',!cid&&'客户未准入',!uid&&'销售不是现有在用业务成员',!name&&'缺售卖产品',!(amount!==null&&amount>=0)&&'合同金额缺失或无效',!stage&&'阶段无效',!sale&&'销售分类缺失或无效',!order&&'订单类型缺失或无效',((prod===null&&!historicalCashMissing)||prod!==null&&(prod<0||prod>amount))&&'cash金额缺失、无效或超过合同金额，不推定为0',!empty(d['预计到单时间'])&&!date(d['预计到单时间'])&&'预计日期无效'].filter(Boolean);
    if(errors.length)return exclude(r,errors);if(one('SELECT id FROM opportunities WHERE reference=?',ref))return exclude(r,'商机编号已存在但来源不同，待核对');
    const id=insert('opportunities',{customer_id:cid,name,owner_id:uid,stage,amount,initial_amount:amount,product_amount:prod,sale_type:sale,order_type:order,next_action:'',follow_date:null,expected_date:date(d['预计到单时间']),stage_at:timestamp(d['最后更新时间'],now),created_at:timestamp(d['创建时间'],now),updated_at:timestamp(d['最后更新时间'],now),reference:ref});
    opportunityMap.set(ref,id);inc('opportunities');record(r,{entity:'opportunity',id});
  }
  function lines(d,total) {
    const prod=parseSourceMoney(d['产品金额']),service=parseSourceMoney(d['项目/服务金额']),types=text(d['产品类型']).split(/[,，]/).map(text).filter(Boolean),serviceKinds=types.filter(k=>['实施','定开','交付','运维'].includes(k));
    if((!empty(d['产品金额'])&&(prod===null||prod<0))||(!empty(d['项目/服务金额'])&&(service===null||service<0)))return {error:'产品/服务金额无效'};
    const list=[];
    if(prod!==null&&service!==null){if(prod+service!==total)return {error:'产品与服务金额合计不等于合同总额'};if(prod>0)list.push({amount:prod,kind:'标品',margin:parseSourceMoney(d['产品毛利'])});if(service>0)list.push({amount:service,kind:serviceKinds.length===1?serviceKinds[0]:null,margin:parseSourceMoney(d['项目/服务毛利'])});}
    else if(prod===total)list.push({amount:total,kind:'标品',margin:parseSourceMoney(d['产品毛利'])});
    else if(service===total)list.push({amount:total,kind:serviceKinds.length===1?serviceKinds[0]:null,margin:parseSourceMoney(d['项目/服务毛利'])});
    else if(prod===null&&service===null&&types.length===1&&itemKinds.has(types[0]))list.push({amount:total,kind:types[0],margin:null});
    else return {error:'缺合计一致的明确合同明细；未建未分类占位行'};
    if(!list.length||list.some(x=>!x.kind))return {error:'合同行项类型不明确'};
    if(list.some(x=>x.margin!==null&&(x.margin<0||x.margin>x.amount)))return {error:'原毛利无效或超过行项金额'};return {list};
  }
  function contract(r) {
    const d=r.data,ref=text(d['合同编号']),prior=existing(r);if(prior){contractMap.set(ref,prior.entity_id);return;}
    const cid=customerId(d['客户名称']),uid=owner(d['销售小二']),amount=parseSourceMoney(d['合同金额']),sign=date(d['合同签订时间']),name=text(d['售卖产品']),end=date(d['产品最新到期时间']),parsed=amount>0?lines(d,amount):{};
    const errors=[!ref&&'缺合同编号',!cid&&'客户未准入',!uid&&'销售不是现有在用业务成员',!name&&'缺合同名称/售卖产品',!(amount>0)&&'合同金额缺失或非正数',!sign&&'缺真实签订日期',!empty(d['产品最新到期时间'])&&!end&&'到期日无效',end&&sign&&end<sign&&'到期早于签订',parsed.error].filter(Boolean);
    if(errors.length)return exclude(r,errors);if(one('SELECT id FROM contracts WHERE contract_no=?',ref))return exclude(r,'合同编号已存在但来源不同，待核对');
    const id=insert('contracts',{customer_id:cid,opportunity_id:null,owner_id:uid,name,contract_no:ref,amount,sign_date:sign,valid_until:end,scope:text(d['合同关键信息摘取']),created_at:timestamp(d['创建时间'],now),lifecycle:'历史登记',commission_policy:'pending',order_type:orderTypes.has(text(d['订单类型']))?text(d['订单类型']):null});
    inc('contracts');contractMap.set(ref,id);const related=[];
    for(const item of parsed.list){const line=insert('contract_items',{contract_id:id,name,kind:item.kind,amount:item.amount,rate:null,margin:item.margin});inc('contract_items');related.push({entity:'contract_item',id:line});}
    db.prepare("UPDATE customers SET status='成交' WHERE id=? AND status='潜在'").run(cid);record(r,{entity:'contract',id,related});
  }
  function payments() {
    const groups=new Map();for(const r of get('项目回款计划')){const refs=text(r.data['合同总表 4']).match(/HT\d+/g)||[],v=parseSourceMoney(r.data['合同金额']);if(refs.length===1&&v>0)groups.set(refs[0],(groups.get(refs[0])||0)+v);}
    for(const r of get('项目回款计划')){
      if(existing(r))continue;const d=r.data,refs=text(d['合同总表 4']).match(/HT\d+/g)||[],cid=refs.length===1?(contractMap.get(refs[0])??one('SELECT id FROM contracts WHERE contract_no=?',refs[0])?.id):null;
      const c=cid?one('SELECT * FROM contracts WHERE id=?',cid):null,total=parseSourceMoney(d['合同金额']),paid=parseSourceMoney(d['已回款金额']),unpaid=parseSourceMoney(d['未回款金额']),paidAt=date(d['实际回款时间']),due=date(d['预计回款时间']);
      const errors=[!c&&'未明确关联已准入合同',c&&customerId(d['客户'])!==c.customer_id&&'客户与合同不一致',!(total>0)&&'计划总额无效',paid!==null&&paid<0&&'已收金额无效',unpaid===null||unpaid<0?'未收金额缺失或无效':null,paid===null&&d['是否回款']!=='否'&&'缺实际已收金额',paid!==null&&unpaid!==null&&paid+unpaid!==total&&'已收与未收不等于计划总额',paid===null&&d['是否回款']==='否'&&unpaid!==total&&'未收与计划总额不一致',paid>0&&(!paidAt||paidAt>now.slice(0,10))&&'缺有效实际到账日',unpaid>0&&!due&&'未收计划缺承诺付款日',c&&groups.get(refs[0])>c.amount&&'同合同原计划合计超过合同额，整组待核对'].filter(Boolean);
      if(errors.length){exclude(r,errors);continue;}
      if(one('SELECT COALESCE(SUM(amount),0) n FROM payments WHERE contract_id=?',cid).n+(paid||0)+unpaid>c.amount){exclude(r,'累计回款及计划超合同总额');continue;}
      const related=[];
      if(paid>0){const id=insert('payments',{contract_id:cid,amount:paid,status:'已到账',pay_date:paidAt,promise_date:due,note:text(d['项目名称']),created_at:now});inc('payments');related.push({entity:'payment',id});}
      if(unpaid>0){const id=insert('payments',{contract_id:cid,amount:unpaid,status:due<now.slice(0,10)?'逾期':'待到账',pay_date:null,promise_date:due,checkpoint_date:due,note:text(d['项目名称']),created_at:now});inc('payments');related.push({entity:'payment',id});}
      if(related.length)record(r,{entity:'contract',id:cid,related});else exclude(r,'无实际到账或未收计划金额');
    }
  }
  function activity(r) {
    if(existing(r))return;const d=r.data,project=r.sheet==='重点项目跟进',day=date(d[project?'项目时间':'拜访日期']),uid=owner(d[project?'销售小二':'拜访人员']),cid=customerId(d[project?'客户':'客户名称']);
    if(!day||!day.startsWith(String(year)+'-')||day>now.slice(0,10))return exclude(r,'缺本年已发生日期');
    if(!project&&d['拜访状态']!=='已完成')return exclude(r,'待拜访计划不作为已发生跟进');let opp=null;
    if(project){const ref=text(d['关联编号']),id=opportunityMap.get(ref)??one('SELECT id FROM opportunities WHERE reference=?',ref)?.id;if(id)opp=one('SELECT * FROM opportunities WHERE id=?',id);}
    else if(uid&&cid){const list=all('SELECT * FROM opportunities WHERE customer_id=? AND owner_id=?',cid,uid);if(list.length===1)opp=list[0];}
    const summary=(project?[d['项目内容'],d['售前方案'],d['项目推进思路']]:[d['拜访目的'],d['拜访结果']]).map(text).filter(Boolean).join('\n');
    if(!uid||!opp||opp.customer_id!==cid||!summary)return exclude(r,'未明确在用销售、实际内容或唯一已准入商机');
    const id=insert('activities',{opportunity_id:opp.id,user_id:uid,source:'历史资料导入',activity_type:project?'手动跟进':'现场拜访',summary,action:'',activity_date:day,created_at:now});inc('activities');record(r,{entity:'activity',id});
  }
  function attachments() {
    for(const file of manifest.files){
      if(!file.relative_path.startsWith('QFCRM-FILE/合同总表/合同附件/')){report.excluded_files.push({...file,reason:'未对应已准入报价/跟进；整包工作簿和旧绩效附件不压入业务库'});continue;}
      const exact=get('合同总表').filter(r=>text(r.data['合同附件']).includes(path.basename(file.relative_path))),ids=[...new Set(file.relative_path.match(/HT\d+/g)||[])],refs=exact.length===1?[text(exact[0].data['合同编号'])]:ids;
      if(refs.length!==1||!contractMap.has(refs[0])){report.excluded_files.push({...file,reason:'合同未通过现行必填/金额校验，附件留包外原件待完善'});continue;}
      const fp=hash('QFCRM:attachment:'+file.relative_path+':'+file.sha256);if(one('SELECT id FROM source_records WHERE fingerprint=?',fp))continue;
      const cid=contractMap.get(refs[0]),content=fs.readFileSync(confined(source,file.relative_path));if(content.length!==file.size||hash(content)!==file.sha256)throw new Error('附件内容与清单不一致，整次导入回滚');
      const old=one("SELECT id FROM attachments WHERE entity='contract' AND entity_id=? AND sha256=?",cid,file.sha256),id=old?.id||insert('attachments',{entity:'contract',entity_id:cid,filename:path.basename(file.relative_path),mime_type:mimeTypes[path.extname(file.relative_path).toLowerCase()]||'application/octet-stream',size:content.length,sha256:file.sha256,content,source_path:file.relative_path,created_at:now,created_by:null});
      if(!old){inc('attachments');report.attachments.files++;report.attachments.bytes+=content.length;}
      insert('source_records',{source:'QFCRM',source_table:'合同附件',source_id:file.relative_path,entity:'attachment',entity_id:id,payload:JSON.stringify({...file,linked_to:{entity:'contract',id:cid}}),source_file:file.relative_path,sheet_name:'',row_number:null,imported_at:now,fingerprint:fp,status:'imported',reason:''});inc('source_records');
    }
  }
  try {
    transaction(db,()=>{
      for(const r of [...get('PPL总表'),...get('合同总表')]){const d=r.data,name=normalize(text(d['客户名称'])),sales=aliases.get(text(d['销售小二']))||text(d['销售小二']);if(name&&sales){if(!ownerEvidence.has(name))ownerEvidence.set(name,new Set());ownerEvidence.get(name).add(sales);}}
      admittedOwners();
      for(const r of get('客户-基础表'))customer(r);
      const cashGuard=grandfatheredCash.size?one("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='opportunities_required_cash_insert' AND tbl_name='opportunities'"):null;
      if(grandfatheredCash.size&&(!cashGuard?.sql||!cashGuard.sql.includes('BEFORE INSERT')||!cashGuard.sql.includes('NEW.product_amount')))throw new Error('历史缺项导入缺少现金新增约束，禁止绕过');
      if(cashGuard)db.exec('DROP TRIGGER opportunities_required_cash_insert');
      try{for(const r of get('PPL总表'))opportunity(r);}
      finally{if(cashGuard){db.exec(cashGuard.sql);if(one("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='opportunities_required_cash_insert'")?.sql!==cashGuard.sql)throw new Error('现金新增约束未原样恢复');}}
      for(const r of get('合同总表'))contract(r);payments();
      for(const r of [...get('重点项目跟进'),...get('K3000 客户上门拜访计划（新）')])activity(r);
      const handled=new Set(['客户-基础表','PPL总表','合同总表','项目回款计划','重点项目跟进','K3000 客户上门拜访计划（新）']);
      for(const [name,rows] of tables)if(!handled.has(name))for(const r of rows)exclude(r,name==='流水登记表'?'实际到账资料无合同编号，不凭客户/同金额猜关联或重复记款':name==='付款计划'?'对外付款，当前无应付模块，不当客户回款':name==='绩效管理'?'旧绩效规则及评分本次不导入；附件按实际业务独立匹配':name==='产品-基础表'?'当前系统没有产品目录读取或维护功能，不写入无使用方的设置数据':'当前系统无对应业务模块');
      if(includeAttachments)attachments();
      verifyAdmittedResult();
      const check=one('PRAGMA integrity_check').integrity_check,fk=all('PRAGMA foreign_key_check');if(check!=='ok'||fk.length)throw new Error('数据库完整性核对失败');report.integrity={check,foreign_key_errors:fk.length};
      if(Object.values(report.created).some(n=>n>0))insert('audit',{user_id:null,action:'按现行业务约束导入真实资料',entity:'source',entity_id:null,detail:JSON.stringify({source:'QFCRM',year,created:report.created,excluded_rows:report.excluded.length}),created_at:now});
    });
    report.totals=Object.fromEntries(['customers','contacts','opportunities','contracts','contract_items','payments','activities','source_records','attachments'].map(t=>[t,one(`SELECT COUNT(*) n FROM ${t}`).n]));
    report.amounts_cents={opportunities:one('SELECT COALESCE(SUM(amount),0) n FROM opportunities').n,contracts:one('SELECT COALESCE(SUM(amount),0) n FROM contracts').n,contract_items:one('SELECT COALESCE(SUM(amount),0) n FROM contract_items').n,received:one("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='已到账'").n,planned:one("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status<>'已到账'").n};
    const accepted=new Map(all("SELECT source_table,COUNT(*) n FROM source_records WHERE source='QFCRM' GROUP BY source_table").map(r=>[r.source_table,r.n]));
    report.excluded_summary=Object.entries(report.rows).map(([sheet,counts])=>({sheet,imported:accepted.get(sheet)||0,excluded:counts.excluded}));
    report.excluded_record_rows=report.excluded.filter(r=>r.kind==='row').length;report.excluded_subrecords=report.excluded.filter(r=>r.kind!=='row').length;return report;
  }finally{db.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,v,i,a)=>v.startsWith('--')?[...pairs,[v.slice(2),a[i+1]]]:pairs,[]));
  if(!args.database||!args.extraction||!args.source||!args.manifest)throw new Error('需显式指定 --database 隔离库 --extraction 提取目录 --source 原件目录 --manifest 清单');
  const result=importQfcrm({database:args.database,extraction:args.extraction,source:args.source,manifest:args.manifest,admitted:args.admitted,year:Number(args.year||2026)});
  if(args.report){
    fs.writeFileSync(args.report,JSON.stringify(result,null,2),'utf8');
    fs.writeFileSync(path.join(path.dirname(args.report),'excluded-manifest.json'),JSON.stringify({created_at:result.imported_at,requirements:result.requirements,rows:result.excluded,files:result.excluded_files,summary:result.excluded_summary},null,2),'utf8');
    const csv=value=>'"'+String(value??'').replace(/^([=+@-])/,'\'$1').replaceAll('"','""')+'"';
    const lines=[['文件','工作表','原始行号','来源编号','对象','未入库原因'],...result.excluded.map(r=>[r.file,r.sheet,r.row,r.source_id,r.kind,r.reason]),...result.excluded_files.map(f=>[f.relative_path,'','','','附件',f.reason])];
    fs.writeFileSync(path.join(path.dirname(args.report),'excluded-manifest.csv'),'\ufeff'+lines.map(r=>r.map(csv).join(',')).join('\r\n'),'utf8');
  }
  console.log(JSON.stringify({created:result.created,totals:result.totals,excluded_rows:result.excluded.length,excluded_files:result.excluded_files.length,integrity:result.integrity,report:args.report||null}));
}
