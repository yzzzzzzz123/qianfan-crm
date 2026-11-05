export function migrateContractAnalysis(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=23').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE contract_attachment_analyses(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id),
      attachment_id INTEGER NOT NULL REFERENCES attachments(id),
      attachment_sha256 TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      filename TEXT NOT NULL,
      model TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN('ready','failed')),
      result TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      generated_at TEXT NOT NULL,
      generated_by INTEGER NOT NULL REFERENCES users(id),
      UNIQUE(contract_id,attachment_sha256,fingerprint,model)
    );
    CREATE INDEX contract_analyses_latest ON contract_attachment_analyses(contract_id,generated_at,id);
    CREATE TRIGGER revision_contract_analyses_insert AFTER INSERT ON contract_attachment_analyses BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER revision_contract_analyses_update AFTER UPDATE ON contract_attachment_analyses BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER revision_contract_analyses_delete AFTER DELETE ON contract_attachment_analyses BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
    INSERT INTO schema_version VALUES(23); COMMIT;`);
  }catch(error){db.exec('ROLLBACK');throw error;}
}
