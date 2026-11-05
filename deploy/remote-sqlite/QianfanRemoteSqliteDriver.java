import java.sql.Connection;
import java.sql.DriverPropertyInfo;
import java.sql.SQLException;
import java.sql.DatabaseMetaData;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Properties;

/** Maps DBeaver's encrypted JDBC username/password to Avatica HTTP authentication. */
public final class QianfanRemoteSqliteDriver extends org.apache.calcite.avatica.remote.Driver {
  private static final String PREFIX = "jdbc:qianfan-sqlite:";
  private static final String REMOTE = "jdbc:avatica:remote:";

  @Override public boolean acceptsURL(String url) throws SQLException {
    return url != null && (url.startsWith(PREFIX) || super.acceptsURL(url));
  }

  @Override public Connection connect(String url, Properties input) throws SQLException {
    if (!acceptsURL(url)) return null;
    Properties info = new Properties();
    if (input != null) info.putAll(input);
    String user = info.getProperty("user");
    String password = info.getProperty("password");
    if (user == null || password == null) throw new SQLException("CRM JDBC credentials are required");
    info.setProperty("authentication", "BASIC");
    info.setProperty("avatica_user", user);
    info.setProperty("avatica_password", password);
    info.setProperty("serialization", "protobuf");
    // Never re-open a lost session during a transaction: callers must reconnect explicitly.
    info.setProperty("transparent_reconnection", "false");
    Connection connection = super.connect(REMOTE + url.substring(PREFIX.length()), info);
    if (connection == null) throw new SQLException("Avatica did not accept the remote JDBC URL");
    return wrapConnection(connection);
  }

  private static Object invoke(Object target, Method method, Object[] args) throws Throwable {
    try { return method.invoke(target, args); }
    catch (InvocationTargetException error) { throw error.getCause(); }
  }

  private static ResultSet metadataQuery(Connection c, String sql, Object... args) throws SQLException {
    PreparedStatement statement = c.prepareStatement(sql);
    try {
      for (int i = 0; i < args.length; i++) statement.setObject(i + 1, args[i]);
      ResultSet result = statement.executeQuery();
      return (ResultSet) Proxy.newProxyInstance(QianfanRemoteSqliteDriver.class.getClassLoader(),
          new Class<?>[] {ResultSet.class}, (proxy, method, values) -> {
            if (method.getName().equals("close")) {
              try { result.close(); } finally { statement.close(); }
              return null;
            }
            return invoke(result, method, values);
          });
    } catch (SQLException error) { statement.close(); throw error; }
  }

  private static final String FOREIGN_KEYS = "SELECT NULL AS PKTABLE_CAT,NULL AS PKTABLE_SCHEM,"
      + "f.\"table\" AS PKTABLE_NAME,f.\"to\" AS PKCOLUMN_NAME,"
      + "NULL AS FKTABLE_CAT,NULL AS FKTABLE_SCHEM,t.name AS FKTABLE_NAME,"
      + "f.\"from\" AS FKCOLUMN_NAME,f.seq+1 AS KEY_SEQ,"
      + "CASE f.on_update WHEN 'CASCADE' THEN 0 WHEN 'RESTRICT' THEN 1 WHEN 'SET NULL' THEN 2"
      + " WHEN 'SET DEFAULT' THEN 4 ELSE 3 END AS UPDATE_RULE,"
      + "CASE f.on_delete WHEN 'CASCADE' THEN 0 WHEN 'RESTRICT' THEN 1 WHEN 'SET NULL' THEN 2"
      + " WHEN 'SET DEFAULT' THEN 4 ELSE 3 END AS DELETE_RULE,"
      + "'fk_'||t.name||'_'||f.id AS FK_NAME,NULL AS PK_NAME,7 AS DEFERRABILITY "
      + "FROM sqlite_schema t JOIN pragma_foreign_key_list(t.name) f WHERE t.type='table' ";

  private static Connection wrapConnection(Connection connection) throws SQLException {
    DatabaseMetaData original = connection.getMetaData();
    return (Connection) Proxy.newProxyInstance(QianfanRemoteSqliteDriver.class.getClassLoader(),
        new Class<?>[] {Connection.class}, (proxy, method, args) -> {
          if (!method.getName().equals("getMetaData")) return invoke(connection, method, args);
          // Avatica's remote metadata API does not transmit key/index metadata. Query SQLite's
          // table-valued PRAGMAs over the existing authenticated connection instead. These are
          // live server queries, not local metadata or a copy of the database.
          return Proxy.newProxyInstance(QianfanRemoteSqliteDriver.class.getClassLoader(),
              new Class<?>[] {DatabaseMetaData.class}, (metadata, operation, values) -> {
                switch (operation.getName()) {
                  case "getConnection": return proxy;
                  case "getDatabaseProductName": return "SQLite";
                  case "getDatabaseProductVersion":
                    try (ResultSet r = metadataQuery(connection,"SELECT sqlite_version()")) {
                      r.next(); return r.getString(1);
                    }
                  case "getDriverName": return "Qianfan CRM Remote SQLite / Apache Avatica";
                  case "getSchemas":
                    return metadataQuery(connection,"SELECT CAST(NULL AS TEXT) AS TABLE_SCHEM,"
                        + "CAST(NULL AS TEXT) AS TABLE_CATALOG WHERE 0");
                  case "getCatalogs":
                    return metadataQuery(connection,"SELECT CAST(NULL AS TEXT) AS TABLE_CAT WHERE 0");
                  case "getPrimaryKeys":
                    return metadataQuery(connection,"SELECT NULL AS TABLE_CAT,NULL AS TABLE_SCHEM,"
                        + "? AS TABLE_NAME,name AS COLUMN_NAME,pk AS KEY_SEQ,"
                        + "NULL AS PK_NAME FROM pragma_table_info(?) WHERE pk>0 ORDER BY pk",
                        values[2],values[2]);
                  case "getImportedKeys":
                    return metadataQuery(connection,FOREIGN_KEYS
                        + "AND t.name=? ORDER BY PKTABLE_NAME,KEY_SEQ",values[2]);
                  case "getExportedKeys":
                    return metadataQuery(connection,FOREIGN_KEYS
                        + "AND f.\"table\"=? ORDER BY FKTABLE_NAME,KEY_SEQ",values[2]);
                  case "getCrossReference":
                    return metadataQuery(connection,FOREIGN_KEYS
                        + "AND f.\"table\"=? AND t.name=? ORDER BY FKTABLE_NAME,KEY_SEQ",
                        values[2],values[5]);
                  case "getIndexInfo":
                    return metadataQuery(connection,"SELECT NULL AS TABLE_CAT,NULL AS TABLE_SCHEM,"
                        + "? AS TABLE_NAME,1-il.\"unique\" AS NON_UNIQUE,NULL AS INDEX_QUALIFIER,"
                        + "il.name AS INDEX_NAME,3 AS TYPE,ii.seqno+1 AS ORDINAL_POSITION,"
                        + "ii.name AS COLUMN_NAME,NULL AS ASC_OR_DESC,0 AS CARDINALITY,"
                        + "0 AS PAGES,NULL AS FILTER_CONDITION FROM pragma_index_list(?) il "
                        + "JOIN pragma_index_info(il.name) ii WHERE (?=0 OR il.\"unique\"=1) "
                        + "ORDER BY NON_UNIQUE,INDEX_NAME,ORDINAL_POSITION",values[2],values[2],
                        Boolean.TRUE.equals(values[3]) ? 1 : 0);
                  default: return invoke(original, operation, values);
                }
              });
        });
  }

  @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties info) throws SQLException {
    return super.getPropertyInfo(url != null && url.startsWith(PREFIX)
        ? REMOTE + url.substring(PREFIX.length()) : url, info);
  }
}
