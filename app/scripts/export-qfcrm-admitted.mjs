import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {normalize} from '../server/domain.mjs';
import {parseSourceMoney} from './import-qfcrm.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const text=value=>value==null?'':String(value).trim();
const aliases=new Map([['暮雪','米粒'],['米粒（王德丽）','米粒']]);
const salesName=value=>aliases.get(text(value))||text(value);
const protectedNames=new Set(['余志政','孙笑天','杨丽莉']);
const entityTables={customer:'customers',contact:'contacts',opportunity:'opportunities',contract:'contracts',contract_item:'contract_items',payment:'payments',activity:'activities',attachment:'attachments'};
const rowKey=r=>JSON.stringify([r.source_file,r.sheet_name,r.row_number]);
const rowFingerprint=(file,sheet,row,data)=>hash(JSON.stringify({source:'QFCRM',file,sheet,row,data}));
const json=value=>Buffer.from(JSON.stringify(value,null,2)+'\n','utf8');
function inside(base,target) {const relative=path.relative(base,target);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
function checkedRelative(relative) {
  if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.includes(':')||relative.includes('\0')||path.posix.isAbsolute(relative)||relative.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('资料路径不安全');
  return relative;
}
function sourceFile(root,relative) {
  checkedRelative(relative);const base=fs.realpathSync(root),target=fs.realpathSync(path.join(base,relative));
  if(!inside(base,target)||!fs.statSync(target).isFile())throw new Error('资料文件超出来源目录');return target;
}

/** Export admitted source evidence, never database IDs, accounts, sessions, or excluded documents. */
export function exportQfcrmAdmitted({database,extraction,source,manifest:manifestPath,output,year=2026}) {
  if(!database||!output)throw new Error('必须指定只读数据库与新建输出目录');
  const destination=path.resolve(output);
  if(fs.existsSync(destination))throw new Error('输出目录已存在，禁止覆盖既有发布包');
  const workbook=JSON.parse(fs.readFileSync(path.join(extraction,'QFCRM.rows.json'),'utf8'));
  const originalManifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const db=new DatabaseSync(path.resolve(database),{readOnly:true});
  try {
    if(db.prepare('SELECT MAX(version) version FROM schema_version').get().version<10)throw new Error('须使用已验收的 schema10 数据库');
    const records=db.prepare("SELECT * FROM source_records WHERE source='QFCRM' ORDER BY id").all();
    if(!records.length||records.some(r=>r.status!=='imported'))throw new Error('来源记录必须全部为已成功准入');
    const rawByKey=new Map(),allRows=[];
    for(const sheet of workbook.sheets)for(const r of sheet.rows.slice(1)){
      const data=Object.fromEntries(sheet.rows[0].values.map((h,i)=>[h,r.values[i]??null]));
      const item={file:workbook.file,sheet:sheet.name,row:r.row,data,raw:r};
      const key=JSON.stringify([workbook.file,sheet.name,r.row]);if(rawByKey.has(key))throw new Error('原表定位重复');rawByKey.set(key,item);allRows.push(item);
    }
    const selectedKeys=new Set(),admittedRows=[],grandfatheredMissingFields=[],entityIds=new Map(Object.keys(entityTables).map(e=>[e,new Set()]));
    function object(entity,id) {
      const table=entityTables[entity];if(!table||!Number.isSafeInteger(id)||id<1)throw new Error('来源对象类型或编号无效');
      const row=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);if(!row)throw new Error('来源业务对象不存在');entityIds.get(entity).add(id);return row;
    }
    for(const r of records){
      object(r.entity,r.entity_id);const payload=JSON.parse(r.payload);
      for(const item of payload.related||[])object(item.entity,item.id);
      if(r.row_number==null)continue;
      const key=rowKey(r),original=rawByKey.get(key);
      if(!original||selectedKeys.has(key)||payload.source_sha256!==workbook.sha256||r.fingerprint!==rowFingerprint(original.file,original.sheet,original.row,original.data)||JSON.stringify(payload.values)!==JSON.stringify(original.data))throw new Error('成功来源与原始文件、行号或指纹不一致');
      if(r.entity==='opportunity'){
        const opportunity=object(r.entity,r.entity_id),cash=parseSourceMoney(original.data['cash金额']);
        const historicalMissing=text(original.data['cash金额'])===''&&opportunity.product_amount===null;
        if(historicalMissing)grandfatheredMissingFields.push({fingerprint:r.fingerprint,field:'product_amount',source_file:r.source_file,sheet_name:r.sheet_name,row_number:r.row_number});
        else if(cash===null||cash<0||cash>opportunity.amount||cash!==opportunity.product_amount)throw new Error('商机cash金额原值与数据库不符，禁止导出');
      }
      selectedKeys.add(key);admittedRows.push({source_file:r.source_file,sheet_name:r.sheet_name,row_number:r.row_number,fingerprint:r.fingerprint,entity:r.entity});
    }
    const evidence=[];
    for(const id of entityIds.get('customer')){
      const customer=db.prepare('SELECT * FROM customers WHERE id=?').get(id),owner=db.prepare('SELECT name,active,business_member,developer_admin FROM users WHERE id=?').get(customer.owner_id);
      if(!owner||!owner.active||!owner.business_member||owner.developer_admin||protectedNames.has(owner.name))throw new Error('客户负责人不属于现有在用业务成员');
      const matches=allRows.filter(r=>['PPL总表','合同总表'].includes(r.sheet)&&normalize(text(r.data['客户名称']))===customer.normalized&&text(r.data['销售小二']));
      const names=new Set(matches.map(r=>salesName(r.data['销售小二'])));
      if(names.size!==1||!names.has(owner.name))throw new Error('原始负责人证据不唯一或与已准入客户不符');
      const customerRows=admittedRows.filter(r=>r.entity==='customer'&&normalize(text(rawByKey.get(rowKey(r)).data['客户']))===customer.normalized);
      if(!customerRows.length)throw new Error('客户缺原始准入行');
      evidence.push({customer_name:customer.name,normalized:customer.normalized,owner_name:owner.name,source_rows:customerRows.map(r=>({sheet:r.sheet_name,row:r.row_number,fingerprint:r.fingerprint})),evidence:matches.map(r=>({sheet:r.sheet,row:r.row,customer_name:text(r.data['客户名称']),sales_name:text(r.data['销售小二'])}))});
    }
    const files=[],buffers=[];
    const add=(relative,content)=>{checkedRelative(relative);if(files.some(f=>f.path===relative))throw new Error('发布包文件重复');files.push({path:relative,size:content.length,sha256:hash(content)});buffers.push({path:relative,content});};
    const minimalWorkbook={file:workbook.file,sha256:workbook.sha256,sheets:workbook.sheets.map(sheet=>({name:sheet.name,rows:[sheet.rows[0],...sheet.rows.slice(1).filter(r=>selectedKeys.has(JSON.stringify([workbook.file,sheet.name,r.row])))]})).filter(s=>s.rows.length>1)};
    add('extraction/QFCRM.rows.json',json(minimalWorkbook));
    const attachmentManifest=[];
    for(const r of records.filter(r=>r.row_number==null)){
      if(r.entity!=='attachment')throw new Error('包中仅允许原表行或已关联附件来源');
      const attachment=object(r.entity,r.entity_id),entry=originalManifest.files.find(f=>f.relative_path===attachment.source_path);
      if(!entry||attachment.entity!=='contract'||!entityIds.get('contract').has(attachment.entity_id)||r.fingerprint!==hash('QFCRM:attachment:'+entry.relative_path+':'+entry.sha256))throw new Error('附件缺已准入合同或原始来源');
      const content=fs.readFileSync(sourceFile(source,entry.relative_path));
      if(content.length!==entry.size||content.length!==attachment.size||hash(content)!==entry.sha256||entry.sha256!==attachment.sha256)throw new Error('附件校验和或大小不一致');
      const payload=JSON.parse(r.payload);if(payload.linked_to?.entity!=='contract'||payload.linked_to?.id!==attachment.entity_id)throw new Error('附件来源合同关系不一致');
      attachmentManifest.push({relative_path:entry.relative_path,size:entry.size,sha256:entry.sha256});add('source/'+entry.relative_path,content);
    }
    add('manifest.json',json({files:attachmentManifest}));
    const sum=(entity,column,predicate=()=>true)=>[...entityIds.get(entity)].map(id=>db.prepare(`SELECT * FROM ${entityTables[entity]} WHERE id=?`).get(id)).filter(predicate).reduce((n,r)=>n+r[column],0);
    const metadata={format:'qfcrm-admitted-historical-v1',year,source:{file:workbook.file,sha256:workbook.sha256},files,admitted_rows:admittedRows,grandfathered_missing_fields:grandfatheredMissingFields,customer_owner_evidence:evidence,expected:{rows:Object.fromEntries(minimalWorkbook.sheets.map(s=>[s.name,s.rows.length-1])),business:Object.fromEntries(Object.entries(entityTables).map(([e,t])=>[t,entityIds.get(e).size])),source_records:records.length,amounts_cents:{opportunities:sum('opportunity','amount'),contracts:sum('contract','amount'),contract_items:sum('contract_item','amount'),received:sum('payment','amount',r=>r.status==='已到账'),planned:sum('payment','amount',r=>r.status!=='已到账')}}};
    // All input verification finishes before a new directory or artifact is written.
    fs.mkdirSync(destination,{recursive:true,mode:0o700});
    for(const item of buffers){const target=path.join(destination,item.path);if(!inside(destination,target))throw new Error('发布包路径越界');fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});fs.writeFileSync(target,item.content,{flag:'wx',mode:0o600});}
    fs.writeFileSync(path.join(destination,'admitted-package.json'),json(metadata),{flag:'wx',mode:0o600});
    return metadata;
  }finally{db.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=Object.fromEntries(process.argv.slice(2).reduce((out,v,i,a)=>v.startsWith('--')?[...out,[v.slice(2),a[i+1]]]:out,[]));
  const result=exportQfcrmAdmitted({database:args.database,extraction:args.extraction,source:args.source,manifest:args.manifest,output:args.output,year:Number(args.year||2026)});
  console.log(JSON.stringify({output:args.output,rows:result.admitted_rows.length,attachments:result.files.filter(f=>f.path.startsWith('source/')).length,bytes:result.files.reduce((n,f)=>n+f.size,0),expected:result.expected}));
}
