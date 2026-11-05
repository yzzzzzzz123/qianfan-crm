export function migrateCustomerProfile(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=21').get())return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE customer_profiles(
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
      state TEXT NOT NULL CHECK(state IN('not_configured','not_read','ready','not_found','mismatch','failed')),
      provider TEXT NOT NULL DEFAULT '',source_url TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '{}',reason TEXT NOT NULL DEFAULT '',
      checked_at TEXT,identity_fingerprint TEXT NOT NULL
    );
    CREATE TRIGGER revision_customer_profiles_insert AFTER INSERT ON customer_profiles BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER revision_customer_profiles_update AFTER UPDATE ON customer_profiles BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
    CREATE TRIGGER revision_customer_profiles_delete AFTER DELETE ON customer_profiles BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
    INSERT INTO schema_version VALUES(21); COMMIT;`);
  }catch(error){db.exec('ROLLBACK');throw error;}
}
