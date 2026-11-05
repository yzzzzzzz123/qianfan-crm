import {intakeSchema,intakeStorage,intakeItemStorage,intakeDestinations,allowedIntakeActions,operationFields} from '../../public/modules/intake-schema.js';
import {tablePurposes,describeColumn} from '../schema-dictionary.mjs';

const columnCache=new WeakMap();
function actualColumns(db) {
  const version=db.prepare('PRAGMA schema_version').get().schema_version,cached=columnCache.get(db);
  if(cached?.version===version)return cached.tables;
  const tables=new Map(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(({name})=>[name,new Set(db.prepare(`PRAGMA table_info("${name.replaceAll('"','""')}")`).all().map(c=>c.name))]));
  columnCache.set(db,{version,tables});return tables;
}
export function verifiedIntakeMapping(db,mapping) {
  if(!mapping)return {kind:'invalid',valid:false,targets:[]};
  const columns=actualColumns(db),targets=(mapping.targets||[]).map(target=>({...target,exists:!!columns.get(target.table)?.has(target.column)}));
  return {...mapping,targets,valid:mapping.kind==='control'?!!mapping.purpose:targets.length>0&&targets.every(target=>target.exists)};
}
export function intakeStorageMatches(db,type,data) {
  return Object.keys(data).every(field=>verifiedIntakeMapping(db,intakeStorage[type]?.[field]).valid)&&(!Array.isArray(data.items)||data.items.every(item=>item&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).every(field=>verifiedIntakeMapping(db,intakeItemStorage[type]?.[field]).valid)));
}

// Describe columns from this actual connection. No record values, identity tokens,
// private settings or independent schema copy are sent to the field guide.
export function businessTableCatalog(db,role) {
  const names=new Set(Object.keys(intakeSchema).filter(type=>allowedIntakeActions(type,role).length).map(type=>intakeDestinations[type]?.table).filter(Boolean));
  const tables={};
  for(const name of names) {
    const existing=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if(!existing)continue;
    const columns=db.prepare(`PRAGMA table_info("${name.replaceAll('"','""')}")`).all();
    tables[name]={name,purpose:tablePurposes[name]||'',columns:columns.map(column=>({name:column.name,type:column.type,notnull:!!column.notnull,defaultValue:column.dflt_value,primaryKey:!!column.pk,description:describeColumn(name,column.name)||'待核对用途'}))};
    tables[name].inputs=Object.fromEntries(Object.keys(intakeSchema).filter(type=>intakeDestinations[type]?.table===name&&allowedIntakeActions(type,role).length).map(type=>{
      const fields=[...new Set(allowedIntakeActions(type,role).flatMap(action=>operationFields(type,action,role)))];
      return [type,{fields:Object.fromEntries(fields.map(field=>[field,verifiedIntakeMapping(db,intakeStorage[type]?.[field])])),items:fields.includes('items')?Object.fromEntries(Object.entries(intakeItemStorage[type]||{}).map(([field,mapping])=>[field,verifiedIntakeMapping(db,mapping)])):{}}];
    }));
  }
  return tables;
}
