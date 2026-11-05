import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {intakeSchema,intakeStorage,intakeItemStorage,intakeTypes,intakeDestinations,operationFields} from '../public/modules/intake-schema.js';
import {intakeFieldLabel} from '../public/modules/intake-guide.js';

const identifier=value=>'"'+String(value).replaceAll('"','""')+'"';

// This checks the real database, without opening the application's migration path.
// A field mapping is not proof that a table is redundant; non-AI columns are listed
// separately for review of their API, calculation, identity and historical uses.
export function auditIntakeStorage(db,{schema=intakeSchema,storage=intakeStorage,items=intakeItemStorage,destinations=intakeDestinations}={}) {
  const problems=[],mapped=new Map(),statistics=new Map();
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,rows:db.prepare(`SELECT COUNT(*) n FROM ${identifier(name)}`).get().n,columns:db.prepare(`PRAGMA table_info(${identifier(name)})`).all().map(c=>c.name)}));
  const actual=new Map(tables.map(t=>[t.name,new Set(t.columns)]));
  function targetStats(target,label) {
    if(!actual.get(target.table)?.has(target.column)){problems.push(`${label}: missing ${target.table}.${target.column}`);return {...target,exists:false};}
    if(!mapped.has(target.table))mapped.set(target.table,new Set());mapped.get(target.table).add(target.column);
    const cacheKey=JSON.stringify(target);
    if(!statistics.has(cacheKey)) {
      let expr=identifier(target.column),where='',params=[],from=identifier(target.table);
      if(target.key!==undefined) {
        if(!actual.get(target.table).has('key')){problems.push(`${label}: configuration key without key column`);return {...target,exists:true};}
        where=' WHERE "key"=?';params.push(target.key);
      }
      if(target.jsonPath!==undefined) {
        if(!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(target.jsonPath)){problems.push(`${label}: invalid JSON path`);return {...target,exists:true};}
        if(target.array){from+=` JOIN json_each(CASE WHEN json_valid(${expr}) THEN ${expr} ELSE '[]' END) AS item`;expr=`CASE WHEN item.type='object' THEN json_extract(item.value,'$.${target.jsonPath}') END`;}
        else expr=`CASE WHEN json_valid(${expr}) THEN json_extract(${expr},'$.${target.jsonPath}') END`;
      }
      const result=db.prepare(`SELECT COUNT(*) rows,COALESCE(SUM(value IS NULL),0) null_values,COALESCE(SUM(value IS NOT NULL AND typeof(value)='text' AND trim(value)=''),0) blank_strings FROM (SELECT ${expr} value FROM ${from}${where})`).get(...params);
      statistics.set(cacheKey,{...result,present_values:result.rows-result.null_values-result.blank_strings});
    }
    return {...target,exists:true,data:statistics.get(cacheKey)};
  }
  const operations=Object.entries(schema).map(([type,definition])=>{
    const fields=definition.fields.split(' '),mapping=storage[type]||{};
    if(!actual.has(destinations[type]?.table))problems.push(`${type}: missing active destination table`);
    for(const key of Object.keys(mapping))if(!fields.includes(key))problems.push(`${type}.${key}: mapping without allowed field`);
    for(const key of definition.required)if(!fields.includes(key))problems.push(`${type}.${key}: required field is not allowed`);
    const itemFields=definition.itemsSchema?.fields||[],itemMapping=items[type]||{};
    for(const key of Object.keys(itemMapping))if(!itemFields.includes(key))problems.push(`${type}.items[].${key}: mapping without allowed field`);
    return {type,label:intakeTypes[type]||type,table:destinations[type]?.table,items:itemFields.map(field=>{
      const entry=itemMapping[field],label=`${type}.items[].${field}`;
      if(!entry||!['stored','derived'].includes(entry.kind)||!entry.targets?.length){problems.push(`${label}: no persistence contract`);return {field,valid:false};}
      return {field,required:definition.itemsSchema.required.includes(field),kind:entry.kind,...(entry.purpose?{purpose:entry.purpose}:{}),targets:entry.targets.map(target=>targetStats(target,label))};
    }),fields:fields.map(field=>{
      const entry=mapping[field],label=`${type}.${field}`;
      if(!entry||!['stored','derived','control'].includes(entry.kind)){problems.push(`${label}: no persistence contract`);return {field,label:intakeFieldLabel(type,field),valid:false};}
      if(entry.kind==='control'&&!entry.purpose)problems.push(`${label}: control has no purpose`);
      if(entry.kind!=='control'&&!entry.targets?.length)problems.push(`${label}: no column targets`);
      return {field,label:intakeFieldLabel(type,field),required_for_create:definition.required.includes(field),actions:['create','update'].filter(action=>definition.actionRoles[action]?.length&&operationFields(type,action).includes(field)),kind:entry.kind,...(entry.purpose?{purpose:entry.purpose}:{}),targets:(entry.targets||[]).map(target=>targetStats(target,label))};
    })};
  });
  for(const type of Object.keys(storage))if(!schema[type])problems.push(`${type}: mapping without active operation`);
  return {generated_at:new Date().toISOString(),read_only:true,schema_version:db.prepare('SELECT MAX(version) n FROM schema_version').get().n,table_count:tables.length,column_count:tables.reduce((n,t)=>n+t.columns.length,0),operation_count:operations.length,field_count:operations.reduce((n,t)=>n+t.fields.length,0),item_field_count:operations.reduce((n,t)=>n+t.items.length,0),problems,ok:problems.length===0,operations,tables:tables.map(t=>({...t,ai_mapped_columns:[...(mapped.get(t.name)||[])].sort(),not_directly_written_by_ai:t.columns.filter(c=>!mapped.get(t.name)?.has(c))})),note:'资料类别和操作不是物理表；系统生成、身份、审计、版本及结算证据字段无需用户上传。NULL统计保留历史未知值，不视为待删除记录。'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=Object.fromEntries(process.argv.slice(2).reduce((entries,value,index,values)=>value.startsWith('--')?[...entries,[value.slice(2),values[index+1]]]:entries,[]));
  if(!args.database||!args.out)throw new Error('请提供 --database 正式库路径 --out 报告路径（仅只读检查）');
  const database=path.resolve(args.database),db=new DatabaseSync(database,{readOnly:true});
  try {
    db.exec('BEGIN');
    const report=auditIntakeStorage(db),output=path.resolve(args.out);
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({...report,database},null,2),'utf8');
    console.log(JSON.stringify({ok:report.ok,schemaVersion:report.schema_version,tables:report.table_count,columns:report.column_count,operations:report.operation_count,fields:report.field_count,problems:report.problems,output}));
    if(!report.ok)process.exitCode=1;
  } finally {db.close();}
}
