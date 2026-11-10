// Item expense details are the source of the existing expense aggregate.
export function migrateContractExpenses(db){
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=35').get())return;
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec(`CREATE TABLE contract_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES contract_items(id),
      amount INTEGER NOT NULL CHECK(typeof(amount)='integer' AND amount>0),
      description TEXT NOT NULL CHECK(length(trim(description))>0 AND length(description)<=500),
      incurred_on TEXT,
      payee TEXT NOT NULL DEFAULT '',
      reference_no TEXT NOT NULL DEFAULT '',
      attachment_id INTEGER REFERENCES attachments(id),
      entry_kind TEXT NOT NULL DEFAULT 'detail' CHECK(entry_kind IN('detail','aggregate')),
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      delete_reason TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX contract_expenses_item ON contract_expenses(item_id,deleted_at);
    CREATE UNIQUE INDEX contract_expenses_aggregate ON contract_expenses(item_id) WHERE entry_kind='aggregate' AND deleted_at IS NULL;
    INSERT INTO contract_expenses(item_id,amount,description,entry_kind,created_at,updated_at)
      SELECT id,business_expense,'历史合同费用支出（待补明细）','aggregate',datetime('now'),datetime('now') FROM contract_items WHERE business_expense>0;`);
    // Each details write updates the aggregate and net margin exactly once.
    const sum=id=>`(SELECT COALESCE(SUM(amount),0) FROM contract_expenses WHERE item_id=${id} AND deleted_at IS NULL)`;
    const refresh=id=>`UPDATE contract_items SET business_expense=${sum(id)},margin=CASE WHEN margin_before_expense IS NULL THEN NULL ELSE margin_before_expense-${sum(id)} END WHERE id=${id};`;
    db.exec(`CREATE TRIGGER contract_expenses_total_insert AFTER INSERT ON contract_expenses BEGIN ${refresh('NEW.item_id')} UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
      CREATE TRIGGER contract_expenses_total_update AFTER UPDATE ON contract_expenses BEGIN ${refresh('OLD.item_id')} ${refresh('NEW.item_id')} UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;
      CREATE TRIGGER contract_expenses_total_delete AFTER DELETE ON contract_expenses BEGIN ${refresh('OLD.item_id')} UPDATE workspace_revision SET revision=revision+1 WHERE id=1; END;`);
    // Legacy aggregate editors continue to work until real details are recorded.
    // They must not overwrite itemized costs or create an unexplained delta.
    for(const operation of ['INSERT','UPDATE']){
      db.exec(`CREATE TRIGGER contract_items_expense_guard_${operation.toLowerCase()} BEFORE ${operation} ON contract_items
        WHEN NEW.business_expense!=${sum('NEW.id')}
        AND EXISTS(SELECT 1 FROM contract_expenses WHERE item_id=NEW.id AND deleted_at IS NULL AND entry_kind='detail')
        BEGIN SELECT RAISE(ABORT,'已有合同费用明细，请在费用明细中调整合计'); END;`);
      db.exec(`CREATE TRIGGER contract_items_expense_sync_${operation.toLowerCase()} AFTER ${operation} ON contract_items
        WHEN NEW.business_expense!=${sum('NEW.id')}
        BEGIN
          UPDATE contract_items SET margin_before_expense=NEW.margin+NEW.business_expense WHERE id=NEW.id AND margin_before_expense IS NULL AND NEW.margin IS NOT NULL;
          UPDATE contract_expenses SET amount=NEW.business_expense,updated_at=datetime('now') WHERE item_id=NEW.id AND entry_kind='aggregate' AND deleted_at IS NULL AND NEW.business_expense>0;
          UPDATE contract_expenses SET deleted_at=datetime('now'),delete_reason='合计修正为0',updated_at=datetime('now') WHERE item_id=NEW.id AND entry_kind='aggregate' AND deleted_at IS NULL AND NEW.business_expense=0;
          INSERT INTO contract_expenses(item_id,amount,description,entry_kind,created_at,updated_at)
            SELECT NEW.id,NEW.business_expense,'合同费用支出合计（待补明细）','aggregate',datetime('now'),datetime('now') WHERE NEW.business_expense>0 AND NOT EXISTS(SELECT 1 FROM contract_expenses WHERE item_id=NEW.id AND deleted_at IS NULL);
        END;`);
    }
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('合同费用明细升级外键检查失败');
    db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1;INSERT INTO schema_version VALUES(35);COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
