// These are new, independently maintained facts. No legacy status or label is
// guessed during migration; amounts and receipt totals remain in their sources.
export function migrateContractWorkflow(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=22').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE contracts ADD COLUMN renewal_tag TEXT CHECK(renewal_tag IS NULL OR renewal_tag IN('新签（自建）','新签（分发）','续费','经销品'));
      ALTER TABLE contracts ADD COLUMN payment_type TEXT CHECK(payment_type IS NULL OR payment_type IN('客户直付天元','千帆收款'));
      ALTER TABLE contracts ADD COLUMN project_status TEXT CHECK(project_status IS NULL OR project_status IN('交付中','验收中','已验收未结算','已结项','运维中','暂停','续费中'));
      ALTER TABLE contracts ADD COLUMN delivery_staff TEXT CHECK(delivery_staff IS NULL OR length(delivery_staff)<=500);
      ALTER TABLE contracts ADD COLUMN project_note TEXT CHECK(project_note IS NULL OR length(project_note)<=3000);`);
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('合同履约字段升级外键检查失败');
    db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1; INSERT INTO schema_version VALUES(22); COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
