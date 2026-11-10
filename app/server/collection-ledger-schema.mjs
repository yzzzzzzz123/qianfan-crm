// Preserve the original payment rows. Plan reconciliation is an additive ledger;
// a plan is never rewritten into cash merely because part of it was received.
export function migrateCollectionLedger(db) {
  if (db.prepare('SELECT 1 FROM schema_version WHERE version=32').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE payments ADD COLUMN reference_no TEXT NOT NULL DEFAULT '';
      ALTER TABLE payments ADD COLUMN voided_at TEXT;
      ALTER TABLE payments ADD COLUMN void_reason TEXT NOT NULL DEFAULT '';
      ALTER TABLE contracts ADD COLUMN terminated_at TEXT;
      ALTER TABLE contracts ADD COLUMN termination_reason TEXT NOT NULL DEFAULT '';
      CREATE TABLE payment_plan_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL REFERENCES payments(id),
        receipt_id INTEGER NOT NULL REFERENCES payments(id),
        amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
        created_at TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id),
        UNIQUE(plan_id,receipt_id), CHECK(plan_id!=receipt_id)
      );
      CREATE INDEX payment_plan_links_receipt ON payment_plan_links(receipt_id);
      CREATE TABLE contract_exit_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contract_id INTEGER NOT NULL REFERENCES contracts(id),
        requested_by INTEGER NOT NULL REFERENCES users(id),
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
        created_at TEXT NOT NULL,
        reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, review_note TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX contract_exit_pending ON contract_exit_requests(contract_id) WHERE status='pending';
    `);
    for (const operation of ['INSERT','UPDATE']) {
      db.exec(`CREATE TRIGGER payment_plan_links_validate_${operation.toLowerCase()} BEFORE ${operation} ON payment_plan_links
        WHEN NOT EXISTS(SELECT 1 FROM payments p JOIN payments r ON r.id=NEW.receipt_id WHERE p.id=NEW.plan_id AND p.status!='已到账' AND (p.voided_at IS NULL ${operation==='UPDATE'?'OR NEW.plan_id=OLD.plan_id AND NEW.receipt_id=OLD.receipt_id AND NEW.amount<=OLD.amount':''}) AND r.status='已到账' AND p.contract_id=r.contract_id)
        OR NEW.amount+(SELECT COALESCE(SUM(amount),0) FROM payment_plan_links WHERE plan_id=NEW.plan_id AND id!=NEW.id)>(SELECT amount FROM payments WHERE id=NEW.plan_id)
        OR NEW.amount+(SELECT COALESCE(SUM(amount),0) FROM payment_plan_links WHERE receipt_id=NEW.receipt_id AND id!=NEW.id)>(SELECT amount FROM payments WHERE id=NEW.receipt_id)
        BEGIN SELECT RAISE(ABORT,'回款计划核销关系或金额无效'); END;`);
    }
    db.exec(`CREATE TRIGGER payments_linked_integrity BEFORE UPDATE ON payments WHEN
      EXISTS(SELECT 1 FROM payment_plan_links WHERE (plan_id=OLD.id OR receipt_id=OLD.id)) AND
      (NEW.contract_id!=OLD.contract_id OR NEW.status='已到账' AND OLD.status!='已到账' OR NEW.status!='已到账' AND OLD.status='已到账'
       OR NEW.amount<(SELECT COALESCE(SUM(amount),0) FROM payment_plan_links WHERE plan_id=OLD.id OR receipt_id=OLD.id))
      BEGIN SELECT RAISE(ABORT,'请先核对已有计划核销关系'); END;`);
    for (const table of ['payment_plan_links','contract_exit_requests']) for (const operation of ['INSERT','UPDATE','DELETE']) {
      db.exec(`CREATE TRIGGER ${table}_revision_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;`);
    }
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('回款核销升级外键检查失败');
    db.exec('INSERT INTO schema_version VALUES(32); UPDATE workspace_revision SET revision=revision+1 WHERE id=1; COMMIT');
  } catch(error) { db.exec('ROLLBACK'); throw error; }
}
