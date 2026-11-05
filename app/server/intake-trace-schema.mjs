import {intakeDestinations} from '../public/modules/intake-schema.js';

// A query view consolidates receipts without copying business rows or changing their IDs.
export function migrateIntakeTrace(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=8').get())return;
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const fallback=Object.entries({...intakeDestinations,performance_review:{module:'performance',label:'绩效评定',table:'performance_reviews'}});
  const cases=key=>'CASE json_extract(r.value,\'$.type\') '+fallback.map(([type,d])=>`WHEN ${quote(type)} THEN ${quote(d[key])}`).join(' ')+' END';
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE INDEX ai_batches_user_recent ON ai_import_batches(user_id,id DESC);
      CREATE INDEX ai_uploads_sha256 ON ai_uploads(sha256,batch_id);
      CREATE VIEW ai_import_records AS
      SELECT b.id batch_id,b.user_id,b.source_role,b.created_at received_at,b.confirmed_at imported_at,
        json_extract(r.value,'$.type') operation_type,
        COALESCE(json_extract(r.value,'$.action'),json_extract(b.operations,'$['||r.key||'].action')) operation_action,
        COALESCE(json_extract(r.value,'$.source_file'),json_extract(b.operations,'$['||r.key||'].source_file')) source_file,
        json_extract(d.value,'$.module') module,
        json_extract(d.value,'$.module_label') module_label,
        json_extract(d.value,'$.table') table_name,
        json_extract(d.value,'$.record_id') record_id,
        json_extract(d.value,'$.record_key') record_key,
        COALESCE(json_extract(d.value,'$.record_label'),json_extract(r.value,'$.type')||' #'||COALESCE(json_extract(r.value,'$.id'),'历史键未记录')) record_label,
        json_extract(d.value,'$.related_records') related_records
      FROM ai_import_batches b
      JOIN json_each(CASE WHEN json_type(b.result)='array' THEN b.result ELSE '[]' END) r
      JOIN json_each(CASE WHEN json_type(r.value,'$.destinations')='array' THEN json_extract(r.value,'$.destinations')
        ELSE json_array(json_object('module',${cases('module')},'module_label',${cases('label')},'table',${cases('table')},'record_id',json_extract(r.value,'$.id'))) END) d
      WHERE b.state='confirmed';
      INSERT INTO schema_version VALUES(8);`);
    db.prepare('SELECT COUNT(*) FROM ai_import_records').get();
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('导入追溯升级外键检查失败');
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
}
