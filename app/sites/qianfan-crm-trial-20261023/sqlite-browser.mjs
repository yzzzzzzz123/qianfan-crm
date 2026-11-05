import initSqlJs from 'sql.js/dist/sql-asm.js';
export const SQL = await initSqlJs();
export class DatabaseSync {
  constructor(){this.inner=new SQL.Database();}
  replace(bytes){this.inner.close();this.inner=bytes?new SQL.Database(bytes):new SQL.Database();this.inner.run('PRAGMA foreign_keys=ON');}
  export(){return this.inner.export();}
  exec(sql){this.inner.run(sql);}
  prepare(sql){const self=this;return {
    all(...args){const s=self.inner.prepare(sql);try{s.bind(args);const rows=[];while(s.step())rows.push(s.getAsObject());return rows;}finally{s.free();}},
    get(...args){return this.all(...args)[0];},
    run(...args){self.inner.run(sql,args);return {changes:self.inner.getRowsModified(),lastInsertRowid:self.inner.exec('SELECT last_insert_rowid()')[0]?.values[0][0]||0};}
  };}
  close(){this.inner.close();}
}
