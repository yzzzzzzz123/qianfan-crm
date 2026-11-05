// Additive upgrade: retain existing records, IDs and financial snapshots.
export function migrateProduction(db) {
  if (db.prepare('SELECT 1 FROM schema_version WHERE version=5').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      ALTER TABLE contacts ADD COLUMN archived_at TEXT;
      CREATE INDEX customers_owner_status ON customers(owner_id,status);
      CREATE INDEX contacts_customer_active ON contacts(customer_id,archived_at);
      CREATE INDEX contracts_opportunity ON contracts(opportunity_id);
      CREATE INDEX contract_items_contract ON contract_items(contract_id);
      CREATE INDEX quotes_opportunity_date ON quotes(opportunity_id,created_at);
      CREATE INDEX events_credited_date ON activity_events(credited_user_id,activity_date);
      CREATE INDEX events_activity ON activity_events(activity_id);
      CREATE INDEX stage_history_opportunity ON stage_history(opportunity_id,at);
      CREATE INDEX commission_lines_contract ON commission_lines(contract_id,item_id);
      CREATE INDEX commission_lines_batch ON commission_lines(batch_id);
      CREATE INDEX sessions_expiry ON sessions(expires);
    `);
    const checks = {
      opportunities: "NEW.stage NOT IN ('线索','初步接触','需求确认','方案沟通','报价','POC 试用','商务谈判','成交','流失') OR NEW.deal_type NOT IN ('new','renewal','collection') OR NEW.mirror NOT IN (0,1) OR NEW.man_days<0 OR NEW.man_days>1000000 OR NEW.est_margin<0 OR typeof(NEW.est_margin)<>'integer' OR NEW.initial_amount<0",
      contract_items: "NEW.man_days<0 OR NEW.man_days>1000000 OR NEW.margin>NEW.amount OR typeof(NEW.amount)<>'integer' OR typeof(NEW.margin)<>'integer'",
      contracts: "NEW.recurring_amount<0 OR NEW.recurring_amount>NEW.amount OR NEW.auto_renew NOT IN (0,1) OR (NEW.valid_until IS NOT NULL AND NEW.valid_until<NEW.sign_date) OR (NEW.opportunity_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM opportunities o WHERE o.id=NEW.opportunity_id AND o.customer_id=NEW.customer_id))",
      payments: "typeof(NEW.amount)<>'integer' OR (NEW.status='已到账' AND NEW.pay_date IS NULL) OR (NEW.status<>'已到账' AND NEW.pay_date IS NOT NULL)",
    };
    for (const [table, condition] of Object.entries(checks)) {
      const invalid = db.prepare(`SELECT COUNT(*) n FROM ${table} AS existing WHERE ${condition.replaceAll('NEW.', 'existing.')}`).get().n;
      if (invalid) throw new Error(`Production migration requires review: ${table}, ${invalid} invalid records; no data changed`);
      for (const operation of ['INSERT','UPDATE']) db.exec(`CREATE TRIGGER ${table}_production_${operation.toLowerCase()} BEFORE ${operation} ON ${table} WHEN ${condition} BEGIN SELECT RAISE(ABORT,'CRM field integrity violation: ${table}'); END;`);
    }
    db.exec('INSERT INTO schema_version VALUES(5); COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
