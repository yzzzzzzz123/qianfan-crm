package org.apache.calcite.avatica.jdbc;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Types;
import java.sql.Statement;
import java.sql.ResultSetMetaData;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.apache.calcite.avatica.AvaticaParameter;
import org.apache.calcite.avatica.Meta;
import org.apache.calcite.avatica.NoSuchStatementException;
import org.apache.calcite.avatica.remote.TypedValue;

/** Xerial SQLite adaptation for Avatica's JDBC adapter; no SQL rewriting. */
public final class QianfanSqliteMeta extends JdbcMeta {
  public QianfanSqliteMeta() throws SQLException {
    super("jdbc:sqlite:/srv/qianfan-crm/data/crm.sqlite"
        + "?open_mode=2&foreign_keys=on&busy_timeout=10000&journal_mode=WAL");
  }

  @Override public void openConnection(ConnectionHandle handle, Map<String,String> properties) {
    super.openConnection(handle,Map.of());
  }

  private static Object call(Object target,Method method,Object[] args) throws Throwable {
    try{return method.invoke(target,args);}
    catch(InvocationTargetException error){throw error.getCause();}
  }

  private static ResultSet result(ResultSet raw) {
    if(raw==null)return null;
    return (ResultSet)Proxy.newProxyInstance(QianfanSqliteMeta.class.getClassLoader(),
        new Class<?>[]{ResultSet.class},(proxy,method,args)->{
          if(!method.getName().equals("getMetaData"))return call(raw,method,args);
          ResultSetMetaData metadata=raw.getMetaData();
          return Proxy.newProxyInstance(QianfanSqliteMeta.class.getClassLoader(),
              new Class<?>[]{ResultSetMetaData.class},(m,operation,values)->{
                // Avatica transports SQLite byte[] values as VARBINARY; its BLOB accessor
                // requires a JDBC Blob object, which SQLite does not provide.
                if(operation.getName().equals("getColumnType")
                    && metadata.getColumnType((Integer)values[0])==Types.BLOB)return Types.VARBINARY;
                return call(metadata,operation,values);
              });
        });
  }

  private static <T extends Statement> T statement(T raw,Class<T> type) {
    return type.cast(Proxy.newProxyInstance(QianfanSqliteMeta.class.getClassLoader(),
        new Class<?>[]{type},(proxy,method,args)->{
          Object value=call(raw,method,args);
          return value instanceof ResultSet?result((ResultSet)value):value;
        }));
  }

  @Override public StatementHandle createStatement(ConnectionHandle handle) {
    try {
      int id=getStatementIdGenerator().getAndIncrement();
      Statement s=statement(getConnection(handle.id).createStatement(),Statement.class);
      getStatementCache().put(id,new StatementInfo(s));
      return new StatementHandle(handle.id,id,null);
    } catch(SQLException error){throw new RuntimeException(error);}
  }

  @Override public StatementHandle prepare(ConnectionHandle handle,String sql,long maxRows) {
    PreparedStatement statement=null;
    try {
      statement=statement(getConnection(handle.id).prepareStatement(sql),PreparedStatement.class);
      setMaxRows(statement,maxRows);
      int count=statement.getParameterMetaData().getParameterCount();
      List<AvaticaParameter> parameters=new ArrayList<>();
      for(int i=1;i<=count;i++) {
        // Xerial infers types only after binding. JDBC setters send actual typed values.
        parameters.add(new AvaticaParameter(false,0,0,Types.JAVA_OBJECT,
            "JAVA_OBJECT","java.lang.Object","?"+i));
      }
      int id=getStatementIdGenerator().getAndIncrement();
      // SQLite exposes no stable result metadata for a DML statement, or for parameters
      // before execution. The execute response supplies the actual result columns.
      Signature signature=new Signature(List.of(),sql,parameters,
          null,CursorFactory.LIST,null);
      getStatementCache().put(id,new StatementInfo(statement));
      return new StatementHandle(handle.id,id,signature);
    } catch(SQLException error) {
      if(statement!=null)try{statement.close();}catch(SQLException ignored){ }
      throw new RuntimeException(error);
    }
  }

  @Override public ExecuteResult execute(StatementHandle handle,List<TypedValue> values,
      int maxRowsInFirstFrame) throws NoSuchStatementException {
    StatementInfo info=getStatementCache().getIfPresent(handle.id);
    if(info==null)throw new NoSuchStatementException(handle);
    try {
      PreparedStatement statement=(PreparedStatement)info.statement;
      if(values!=null)for(int i=0;i<values.size();i++) {
        if(values.get(i)==null)throw new SQLException("Unbound parameter");
        statement.setObject(i+1,values.get(i).toJdbc(calendar));
      }
      if(!statement.execute()) {
        info.setResultSet(null);
        return new ExecuteResult(List.of(JdbcResultSet.count(handle.connectionId,handle.id,
            statement.getUpdateCount())));
      }
      // Xerial initializes result columns in getResultSet(), after execute(). Reading
      // PreparedStatement.getMetaData() first leaves its result metadata uninitialized.
      ResultSet result=statement.getResultSet();
      info.setResultSet(result);
      handle.signature=new Signature(columns(result.getMetaData()),handle.signature.sql,
          handle.signature.parameters,null,CursorFactory.LIST,Meta.StatementType.SELECT);
      return new ExecuteResult(List.of(JdbcResultSet.create(handle.connectionId,handle.id,
          result,maxRowsInFirstFrame,handle.signature)));
    } catch(SQLException error) { throw new RuntimeException(error); }
  }
}
