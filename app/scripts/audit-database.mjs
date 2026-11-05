import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';

// Metadata and counts only. This deliberately does not import the migration runner.
export function auditDatabase(filename) {
  const db=new DatabaseSync(filename,{readOnly:true});
  try {
    db.exec('BEGIN');
    const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name,sql})=>{
      if(!/^[a-z_][a-z0-9_]*$/.test(name))throw new Error('Invalid identifier');
      const columns=db.prepare(`PRAGMA table_info(${name})`).all().map(c=>{
        if(!/^[a-z_][a-z0-9_]*$/.test(c.name))throw new Error('Invalid field identifier');
        return {name:c.name,type:c.type,is_nullable:c.notnull||c.pk?'NO':'YES',column_default:c.dflt_value,populated:db.prepare(`SELECT count(*) n FROM ${name} WHERE "${c.name}" IS NOT NULL AND CAST("${c.name}" AS TEXT)<>''`).get().n};
      });
      return {name,count:db.prepare(`SELECT count(*) n FROM ${name}`).get().n,columns,definition:sql,foreignKeys:db.prepare(`PRAGMA foreign_key_list(${name})`).all(),indexes:db.prepare("SELECT name,sql AS definition FROM sqlite_master WHERE type='index' AND tbl_name=?").all(name),triggers:db.prepare("SELECT name,sql AS definition FROM sqlite_master WHERE type='trigger' AND tbl_name=?").all(name)};
    });
    return {generatedAt:new Date().toISOString(),driver:'sqlite',version:db.prepare('SELECT max(version) n FROM schema_version').get().n,integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,foreignKeyViolations:db.prepare('PRAGMA foreign_key_check').all().length,tables};
  } finally {db.close();}
}
if(process.argv.includes('--database')) {
  const filename=process.argv[process.argv.indexOf('--database')+1],output=process.argv[process.argv.indexOf('--output')+1];
  if(!filename||!process.argv.includes('--output')||!output)throw new Error('Explicit --database and --output required');
  const result=auditDatabase(filename);writeFileSync(output,JSON.stringify(result,null,2));
  console.log(JSON.stringify({tables:result.tables.length,fields:result.tables.reduce((n,t)=>n+t.columns.length,0),version:result.version,integrity:result.integrity,foreignKeyViolations:result.foreignKeyViolations}));
}
