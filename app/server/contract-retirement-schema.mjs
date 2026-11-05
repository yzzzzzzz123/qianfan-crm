// A retired import cohort is retained for audit and references. This is
// separate from archived_at, which confirms a signed contract's filing.
export function migrateContractRetirement(db){
 if(db.prepare('SELECT 1 FROM schema_version WHERE version=29').get())return;
 db.exec('BEGIN IMMEDIATE');
 try{
  db.exec('ALTER TABLE contracts ADD COLUMN retired_at TEXT; CREATE INDEX contracts_current ON contracts(retired_at,owner_id);');
  db.exec('DROP INDEX IF EXISTS contracts_number; CREATE UNIQUE INDEX contracts_number ON contracts(contract_no) WHERE contract_no IS NOT NULL AND retired_at IS NULL;');
  db.exec('INSERT INTO schema_version VALUES(29); UPDATE workspace_revision SET revision=revision+1 WHERE id=1; COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
