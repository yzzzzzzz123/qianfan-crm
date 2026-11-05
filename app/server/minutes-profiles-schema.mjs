// A saved CLI profile is an authorization candidate, not proof of CRM ownership.
export function migrateVerifiedMinutesProfiles(db){
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=19').get())return;
  db.exec('BEGIN IMMEDIATE');
  try{
    db.exec("ALTER TABLE minutes_authorizations ADD COLUMN verified_profiles TEXT NOT NULL DEFAULT '[]'");
    for(const a of db.prepare('SELECT * FROM minutes_authorizations').all()){
      const profiles=db.prepare('SELECT corp_id,user_id,account_name,corp_name FROM minutes_sources WHERE member_id=? AND credential_key=?').all(a.member_id,a.credential_key||a.id).map(s=>({corpId:s.corp_id,userId:s.user_id,profile:s.corp_id+':'+s.user_id,accountName:s.account_name,corpName:s.corp_name}));
      if(a.status==='pending_confirmation'&&a.candidate){const c=JSON.parse(a.candidate);if(typeof c.profile==='string'&&c.profile===c.corpId+':'+c.userId&&!profiles.some(p=>p.profile===c.profile))profiles.push(c);}
      db.prepare('UPDATE minutes_authorizations SET verified_profiles=? WHERE id=?').run(JSON.stringify(profiles),a.id);
    }
    db.exec('INSERT INTO schema_version VALUES(19); COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
