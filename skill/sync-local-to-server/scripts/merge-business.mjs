// Bounded, additive merge of a frozen, reviewed business snapshot. Conflicts abort.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const [file,snapshotFile,expectedSha,mode='dry-run']=process.argv.slice(2);
assert.ok(['dry-run','commit'].includes(mode));
const bytes=fs.readFileSync(snapshotFile),hash=b=>createHash('sha256').update(b).digest('hex');
assert.equal(hash(bytes),expectedSha,'Frozen snapshot changed');
const input=JSON.parse(bytes);assert.equal(input.format,'qfcrm-full-sync-v1');
const allowed=['users','customers','customer_collaborators','contacts','opportunities','contracts','contract_items','payments','activities','activity_events','quotes','targets','commission_batches','commission_lines','performance_reviews','daily_reports','stage_history','ai_import_batches','ai_uploads','attachments','source_records','settings'];
assert.deepEqual(Object.keys(input.tables).sort(),[...allowed].sort());
const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=10000');
const qi=s=>'"'+s.replaceAll('"','""')+'"';
const decode=v=>v&&typeof v==='object'&&Object.keys(v).length===1&&typeof v.$blob==='string'?Buffer.from(v.$blob,'base64'):v;
const canon=v=>v instanceof Uint8Array?{$blob:Buffer.from(v).toString('base64')}:v;
const equal=(a,b)=>JSON.stringify(canon(a))===JSON.stringify(canon(b));
assert.equal(db.prepare('SELECT max(version) AS n FROM schema_version').get().n,13);
const report={mode,verifiedRows:0,inserted:{},existing:{},updated:{},attachmentsVerified:0,preservedServerData:true};
const protectedTables=['sessions','ding_identities','audit','mutations'];
const digest=t=>hash(Buffer.from(JSON.stringify(db.prepare('SELECT * FROM '+qi(t)).all())));
const before=Object.fromEntries(protectedTables.map(t=>[t,digest(t)]));
const guards=['customers_required_owner_insert','opportunities_required_cash_insert','opportunities_required_classification_insert'].map(name=>{const x=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);assert.ok(x,'Missing historical import guard');return x;});
db.exec('BEGIN IMMEDIATE');
try{
 for(const g of guards)db.exec('DROP TRIGGER '+qi(g.name));
 for(const t of allowed){
  const columns=db.prepare('PRAGMA table_info('+qi(t)+')').all();
  assert.deepEqual(columns.map(x=>x.name),input.columns[t],'Column mismatch: '+t);
  const keys=columns.filter(x=>x.pk).sort((a,b)=>a.pk-b.pk).map(x=>x.name);assert.deepEqual(keys,input.keys[t]);assert.ok(keys.length);
  const names=input.columns[t],find=db.prepare('SELECT * FROM '+qi(t)+' WHERE '+keys.map(k=>qi(k)+' IS ?').join(' AND '));
  const insert=db.prepare('INSERT INTO '+qi(t)+'('+names.map(qi).join(',')+') VALUES('+names.map(()=>'?').join(',')+')');
  report.inserted[t]=0;report.existing[t]=0;report.updated[t]=0;
  for(const raw of input.tables[t]){
   const row=Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,decode(v)]));assert.deepEqual(Object.keys(row),names);
   const old=find.get(...keys.map(k=>row[k]));
   const localFields=names.filter(k=>!(old&&(['created_at','updated_at','imported_at'].includes(k)||t==='users'&&k==='ding_user_id'||t==='daily_reports'&&k==='snapshot')));
   if(old){
    const changed=localFields.filter(k=>!equal(row[k],old[k]));
    if(changed.length){
     if(t==='contracts'){
      assert.ok(changed.every(k=>['sale_type','order_type'].includes(k)&&old[k]===null&&['续费','代销','经销','千帆'].includes(row[k])),'Contract enrichment is not an empty-field fill');
      const source=input.tables.source_records.find(r=>r.entity==='contract'&&r.entity_id===row.id&&r.sheet_name==='合同总表');assert.ok(source,'Contract original source missing');const raw=JSON.parse(source.payload).values;
      if(changed.includes('order_type'))assert.equal(row.order_type,raw['订单类型']);if(changed.includes('sale_type'))assert.ok(raw['产品续签标签'].startsWith('续签'));
     }else if(t==='source_records'){
      assert.ok(changed.every(k=>['payload','reason'].includes(k)),'Unexpected source evidence field');
      if(changed.includes('reason'))assert.ok(row.reason.startsWith(old.reason),'Original source note must remain');
      if(changed.includes('payload')){const a=JSON.parse(old.payload),b=JSON.parse(row.payload),ar=a.related||[],br=b.related||[];delete a.related;delete b.related;for(const k of ['extension','zip_crc32'])if(a[k]===undefined)delete b[k];assert.deepEqual(b,a,'Raw source evidence changed');assert.deepEqual(br.slice(0,ar.length),ar,'Existing source relations changed');}
     }else throw Error('Concurrent/conflicting existing record: '+t+' fields='+changed.join(','));
     db.prepare('UPDATE '+qi(t)+' SET '+changed.map(k=>qi(k)+'=?').join(',')+' WHERE '+keys.map(k=>qi(k)+' IS ?').join(' AND ')).run(...changed.map(k=>row[k]),...keys.map(k=>row[k]));report.updated[t]++;
    }
    report.existing[t]++;
   }
   else{insert.run(...names.map(k=>row[k]));report.inserted[t]++;}
   const actual=find.get(...keys.map(k=>row[k]));assert.ok(localFields.every(k=>equal(row[k],actual[k])),'Readback mismatch '+t);report.verifiedRows++;
   if(t==='attachments'){const content=actual.content instanceof Uint8Array?actual.content:Buffer.from(actual.content,'base64');assert.equal(content.length,actual.size);assert.equal(hash(content),actual.sha256);report.attachmentsVerified++;}
  }
 }
 for(const g of guards)db.exec(g.sql);
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 for(const t of protectedTables)assert.equal(digest(t),before[t],'Protected table changed: '+t);
 if(mode==='commit'){db.prepare('UPDATE workspace_revision SET revision=revision+1 WHERE id=1').run();db.exec('COMMIT');}else db.exec('ROLLBACK');
 report.totalInserted=Object.values(report.inserted).reduce((a,b)=>a+b,0);report.committed=mode==='commit';
 console.log(JSON.stringify(report));
}catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
