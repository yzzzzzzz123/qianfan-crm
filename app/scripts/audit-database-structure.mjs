import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../server/database.mjs';
import {RETIRED_TABLES,RETIRED_OPPORTUNITY_FIELDS} from '../server/clean-schema.mjs';
import {RETIRED_FIELDS_24} from '../server/retired-fields-schema.mjs';
import {RETIRED_FIELDS_30} from '../server/retired-renewal-schema.mjs';

import {tablePurposes as purposes,describeColumn} from '../server/schema-dictionary.mjs';

const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,list)=>value.startsWith('--')?[...pairs,[value.slice(2),list[index+1]]]:pairs,[]));
if(!args.out)throw new Error('请提供 --out；--database 可选，省略时仅生成隔离内存结构');
const db=args.database?new DatabaseSync(path.resolve(args.database),{readOnly:true}):openDatabase(':memory:');
try{
  const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(table=>({
    name:table.name,purpose:purposes[table.name]||null,ddl:table.sql,
    columns:db.prepare('PRAGMA table_info('+table.name+')').all().map(column=>({...column,purpose:describeColumn(table.name,column.name)})),
    foreign_keys:db.prepare('PRAGMA foreign_key_list('+table.name+')').all(),
  }));
  const missing=tables.flatMap(table=>[...(!table.purpose?[table.name]:[]),...table.columns.filter(c=>!c.purpose).map(c=>table.name+'.'+c.name)]);
  const retired=Object.fromEntries([['customers',['ppl_id',...RETIRED_FIELDS_24.customers]],['opportunities',[...RETIRED_OPPORTUNITY_FIELDS,'ppl_ref']],['contracts',['source_sales','quote_file',...RETIRED_FIELDS_24.contracts,...RETIRED_FIELDS_30.contracts]],['users',['password']]].map(([table,cols])=>[table,cols.filter(col=>tables.find(t=>t.name===table)?.columns.some(c=>c.name===col))]));
  const businessRequiredNulls=Object.fromEntries(Object.entries({customers:['owner_id'],opportunities:['owner_id','sale_type','order_type','product_amount'],contracts:['owner_id']}).flatMap(([table,columns])=>columns.map(column=>[table+'.'+column,db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column} IS NULL`).get().n])));
  const classificationWriteTriggers=['insert','update'].every(operation=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get('opportunities_required_classification_'+operation));
  const cashWriteTriggers=['insert','update'].every(operation=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get('opportunities_required_cash_'+operation));
  const report={generated_at:new Date().toISOString(),database:args.database?path.resolve(args.database):'isolated-memory-schema',schema_version:db.prepare('SELECT MAX(version) version FROM schema_version').get().version,table_count:tables.length,column_count:tables.reduce((n,t)=>n+t.columns.length,0),tables,views:db.prepare("SELECT name,sql FROM sqlite_master WHERE type='view' ORDER BY name").all(),unexplained:missing,retired_tables_present:RETIRED_TABLES.filter(name=>tables.some(t=>t.name===name)),retired_columns_present:retired,required_owner_constraints:['customers','opportunities','contracts'].every(name=>tables.find(t=>t.name===name)?.columns.find(c=>c.name==='owner_id')?.notnull===1 || ['insert','update'].every(operation=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name+'_required_owner_'+operation))),foreign_key_errors:db.prepare('PRAGMA foreign_key_check').all(),integrity:db.prepare('PRAGMA integrity_check').get().integrity_check};
  report.business_required_nulls=businessRequiredNulls;
  report.historical_missing_fields=Object.fromEntries(['sale_type','order_type','product_amount'].map(column=>['opportunities.'+column,businessRequiredNulls['opportunities.'+column]]));
  report.historical_missing_fields['customers.owner_id']=businessRequiredNulls['customers.owner_id'];
  report.unexplained_missing_customer_owners=db.prepare("SELECT COUNT(*) n FROM customers c WHERE c.owner_id IS NULL AND NOT EXISTS(SELECT 1 FROM source_records s WHERE s.entity='customer' AND s.entity_id=c.id AND s.status='imported' AND s.reason!='')").get().n;
  report.unexplained_missing_business_owners=Object.fromEntries(['opportunities','contracts'].map(table=>[table,db.prepare("SELECT COUNT(*) n FROM "+table+" r WHERE r.owner_id IS NULL AND NOT EXISTS(SELECT 1 FROM source_records s WHERE s.entity=? AND s.entity_id=r.id AND s.status IN('imported','archived') AND s.reason!='')").get(table==='opportunities'?'opportunity':'contract').n]));
  report.required_classification_write_triggers=classificationWriteTriggers;
  report.required_cash_write_triggers=cashWriteTriggers;
  report.invalid_cash_amounts=db.prepare("SELECT COUNT(*) n FROM opportunities WHERE product_amount IS NOT NULL AND (typeof(product_amount)<>'integer' OR product_amount<0 OR product_amount>amount)").get().n;
  const output=path.resolve(args.out);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2),'utf8');
  const ok=!missing.length&&!report.retired_tables_present.length&&!Object.values(retired).some(list=>list.length)&&report.required_owner_constraints&&!Object.values(report.unexplained_missing_business_owners).some(count=>count!==0)&&report.unexplained_missing_customer_owners===0&&classificationWriteTriggers&&cashWriteTriggers&&report.invalid_cash_amounts===0&&!report.foreign_key_errors.length&&report.integrity==='ok';
  console.log(JSON.stringify({ok,schemaVersion:report.schema_version,tableCount:report.table_count,columnCount:report.column_count,unexplained:missing,output}));if(!ok)process.exitCode=1;
}finally{db.close();}
