import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openDatabase} from '../server/database.mjs';
import {normalize} from '../server/domain.mjs';
import {parseSourceMoney} from './import-qfcrm.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const base='EpGBa2Lm8amK9zQLhZrdY5aG8gN7R35y';
const owners={'1167413560940388':'王宏','3108636956737201':'祝天','2911693249794141':'米粒','493149406':'刘国庆'};
const stages={'线索阶段':'线索','需求阶段':'需求','方案阶段':'方案','商务阶段':'商务','赢单':'赢单','输单':'输单','搁置':'搁置'};
const saleTypes={'新签（自建）':'新签自建','新签（分发）':'新签分发','续费':'续费','增购':'增购'};
const check=(v,m)=>{if(!v)throw Error(m);};
const hash=v=>createHash('sha256').update(v).digest('hex');
const local=(p,allowed)=>{const resolved=fs.realpathSync(p),rel=path.relative(path.join(root,allowed),resolved);check(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel),'路径必须位于本项目本地 '+allowed);return resolved;};
const str=v=>typeof v==='string'?v.trim():'';

export function importFourSales({database,snapshot,customers,expectedHash,apply=false,deployment}={}){
 check(deployment==='local'&&process.env.CRM_RUNTIME_ENVIRONMENT!=='server'&&process.env.NODE_ENV!=='production','仅允许本地离线导入');
 const dbPath=fs.realpathSync(database);
 check(['app/data','runtime'].some(dir=>{const r=path.relative(path.join(root,dir),dbPath);return r&&!r.startsWith('..')&&!path.isAbsolute(r);}), '数据库仅允许本地 app/data 或 runtime');
 check(!/(?:^|[\\/])(?:production|releases|server)[\\/]/i.test(path.relative(root,dbPath)),'禁止操作服务器目录');
 const sourceBytes=fs.readFileSync(local(snapshot,'runtime')),sourceHash=hash(sourceBytes);
 check(sourceHash===expectedHash,'来源快照指纹不一致');
 const payload=JSON.parse(sourceBytes),rows=payload?.data?.records;
 check(payload.success===true&&payload.data.hasMore===false&&Array.isArray(rows)&&rows.length===472&&new Set(rows.map(r=>r.recordId)).size===rows.length,'来源不是已完成分页的完整 PPL 总表');
 const customerPayload=JSON.parse(fs.readFileSync(local(customers,'runtime'),'utf8'));
 check(customerPayload.success===true&&Array.isArray(customerPayload?.data?.records),'客户引用读取失败');
 const customerNames=new Map(customerPayload.data.records.map(r=>[r.recordId,str(r.cells?.['6ZoH1rW'])]));
 const selected=[];
 for(const r of rows){
  const people=r.cells?.['bjXP16J'];if(!Array.isArray(people)||people.length!==1)continue;
  const p=people[0],name=owners[p.userId]||(p.userName==='米粒'&&p.userRef==='ur_7fR5ujrhi9uv2vpTXtaLCd'?'米粒':null);
  if(name)selected.push({r,name});
 }
 const counts=Object.fromEntries(['王宏','祝天','米粒','刘国庆'].map(n=>[n,selected.filter(x=>x.name===n).length]));
 check(JSON.stringify(counts)===JSON.stringify({'王宏':65,'祝天':150,'米粒':77,'刘国庆':10}),'四人来源数量与核对范围不一致');
 const report={source_hash:sourceHash,source_total:rows.length,source_people:counts,source_read_only:true,restored:0,created:0,existing:0,updated_amount:0,source_records_added:0,missing_customer:0,missing_reference:0,conflicts:[]};
 if(!apply)return {...report,status:'source-validated'};
 const db=openDatabase(dbPath),all=(s,...a)=>db.prepare(s).all(...a),one=(s,...a)=>db.prepare(s).get(...a),run=(s,...a)=>db.prepare(s).run(...a);
 const quote=s=>'"'+s.replaceAll('"','""')+'"';
 const insert=(t,o)=>Number(run(`INSERT INTO ${quote(t)} (${Object.keys(o).map(quote).join(',')}) VALUES (${Object.keys(o).map(()=>'?').join(',')})`,...Object.values(o)).lastInsertRowid);
 const at=new Date().toISOString();
 try{
  db.exec('BEGIN IMMEDIATE');
  const guards=all("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('opportunities_required_customer_insert','opportunities_required_cash_insert','opportunities_required_classification_insert') ORDER BY name");
  check(guards.length===3,'历史导入约束不完整');
  for(const g of guards)db.exec('DROP TRIGGER '+quote(g.name));
  for(const {r,name} of selected){
   const d=r.cells,ref=str(d['bXN6fqm'])||null,sourceStage=str(d['OB0tqmh']?.name),stage=stages[sourceStage],amount=parseSourceMoney(d['A2WBIdv']);
   const user=one("SELECT * FROM users WHERE name=? AND active=1 AND business_member=1 AND developer_admin=0",name);
   check(user&&owners[user.ding_user_id]===name,'销售身份未唯一匹配 '+name);
   check(stage&&Number.isSafeInteger(amount)&&amount>=0&&str(d['Orox2ix'])&&Number.isFinite(Date.parse(d['Orox2ix'])),'来源商机关键信息无效 '+r.recordId);
   const priorBySource=all("SELECT DISTINCT entity_id FROM source_records WHERE source='QFCRM' AND source_table='PPL总表' AND source_id=? AND entity='opportunity' AND entity_id IS NOT NULL",r.recordId);
   check(priorBySource.length<=1,'来源对应多个商机 '+r.recordId);
   const byRef=ref?one('SELECT * FROM opportunities WHERE reference=?',ref):null;
   const bySource=priorBySource.length?one('SELECT * FROM opportunities WHERE id=?',priorBySource[0].entity_id):null;
   check(!byRef||!bySource||byRef.id===bySource.id,'来源编号与已有记录冲突 '+r.recordId);
   let existing=byRef||bySource,id;
   if(existing){
    check(existing.owner_id===user.id&&existing.stage===stage,'已有负责人或阶段与来源不一致，需人工核对 '+r.recordId);
    check(one("SELECT 1 FROM source_records WHERE entity='opportunity' AND entity_id=? AND source='QFCRM' AND source_table='PPL总表'",existing.id),'已有商机缺少 QFCRM 来源证据 '+r.recordId);
    id=existing.id;
    if(existing.archived_at){run('UPDATE opportunities SET archived_at=NULL WHERE id=?',id);report.restored++;}else report.existing++;
    if(str(d['MQVbyGS'])&&str(d['MQVbyGS'])!==existing.name)report.conflicts.push({record_id:r.recordId,field:'售卖产品'});
    if(amount!==existing.amount){
     const oldEvidence=all("SELECT payload FROM source_records WHERE source='QFCRM' AND source_table='PPL总表' AND entity='opportunity' AND entity_id=? ORDER BY id DESC",id).some(s=>{try{return parseSourceMoney(JSON.parse(s.payload)?.values?.['合同金额'])===existing.amount;}catch{return false;}});
     const audited=one("SELECT 1 FROM audit WHERE entity='opportunity' AND entity_id=? LIMIT 1",id);
     const newer=Number.isFinite(Date.parse(d['dAoxlQ4']))&&Date.parse(d['dAoxlQ4'])>Date.parse(existing.updated_at);
     if(existing.archived_at&&oldEvidence&&!audited&&newer&&(existing.product_amount===null||existing.product_amount<=amount)){
      run('UPDATE opportunities SET amount=?,updated_at=? WHERE id=?',amount,d['dAoxlQ4'],id);report.updated_amount++;
     }else report.conflicts.push({record_id:r.recordId,field:'合同金额'});
    }
   }else{
    const links=d['4lLlNol']?.linkedRecordIds||[];check(Array.isArray(links)&&links.length<=1,'来源客户关联不唯一 '+r.recordId);
    let customerId=null;
    if(links.length){const customerName=customerNames.get(links[0]);check(customerName,'缺少已读回的客户引用 '+r.recordId);const matches=all('SELECT id FROM customers WHERE normalized=?',normalize(customerName));check(matches.length===1,'来源客户无法唯一匹配现有客户 '+r.recordId);customerId=matches[0].id;}
    const cash=parseSourceMoney(d['xzUmJBc']),product=cash!==null&&cash>=0&&cash<=amount?cash:null;
    const order=str(d['Bt6x2PN']?.name),sale=str(d['ohLu5jW']?.name),expected=str(d['BTyPhKq']);
    id=insert('opportunities',{name:str(d['MQVbyGS']),customer_id:customerId,owner_id:user.id,stage,amount,initial_amount:amount,product_amount:product,sale_type:saleTypes[sale]||null,order_type:['代销','经销','千帆'].includes(order)?order:null,next_action:'',follow_date:null,expected_date:/^\d{4}-\d{2}-\d{2}/.test(expected)?expected.slice(0,10):null,stage_at:d['Orox2ix'],lost_reason:'',created_at:d['Orox2ix'],updated_at:str(d['dAoxlQ4'])||d['Orox2ix'],reference:ref,collaborator_pm:null,archived_at:null});
    report.created++;if(customerId===null)report.missing_customer++;if(ref===null)report.missing_reference++;
   }
   const fingerprint=hash(JSON.stringify(['four-sales-opportunities-v1',sourceHash,r.recordId]));
   if(!one('SELECT id FROM source_records WHERE fingerprint=?',fingerprint)){insert('source_records',{source:'QFCRM',source_table:'PPL总表',source_id:r.recordId,entity:'opportunity',entity_id:id,payload:JSON.stringify({format:'qfcrm-three-table-v1',base_id:base,record_id:r.recordId,raw:r,opportunity:{sales_names:[name],source_reference_missing:!ref}}),source_file:'https://alidocs.dingtalk.com/i/nodes/'+base,sheet_name:'PPL总表',row_number:null,imported_at:at,fingerprint,status:'imported',reason:'四位销售全时间来源核对；历史缺失值按原样保留'});report.source_records_added++;}
  }
  for(const g of guards)db.exec(g.sql);
  check(all('PRAGMA foreign_key_check').length===0&&one('PRAGMA quick_check').quick_check==='ok','数据库完整性验证失败');
  if(report.restored||report.created||report.updated_amount||report.source_records_added)insert('audit',{user_id:null,action:'本地补齐四位销售全部商机',entity:'source',entity_id:null,detail:JSON.stringify(report),created_at:at});
  db.exec('COMMIT');return {...report,status:'complete'};
 }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const opts={};for(let i=2;i<process.argv.length;i++){const k=process.argv[i];if(k==='--apply')opts.apply=true;else{check(process.argv[i+1]&&!process.argv[i+1].startsWith('--'),'参数缺值 '+k);opts[k.slice(2)]=process.argv[++i];}}
 try{const result=importFourSales({database:opts.database,snapshot:opts.snapshot,customers:opts.customers,expectedHash:opts.sha256,apply:opts.apply,deployment:opts.deployment});if(opts.report)fs.writeFileSync(opts.report,JSON.stringify(result,null,2));console.log(JSON.stringify(result));}catch(e){console.error(e.stack);process.exitCode=1;}
}
