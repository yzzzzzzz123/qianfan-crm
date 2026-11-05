import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.apache.calcite.avatica.jdbc.QianfanSqliteMeta;
import org.apache.calcite.avatica.remote.Driver.Serialization;
import org.apache.calcite.avatica.remote.LocalService;
import org.apache.calcite.avatica.server.HttpServer;
import org.apache.calcite.avatica.server.ServerCustomizer;
import org.eclipse.jetty.server.Connector;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;
import org.eclipse.jetty.util.thread.QueuedThreadPool;

/** SSH-only JDBC access to the same SQLite file used by the CRM service. */
public final class QianfanSqliteServer {
  private static final Path DATABASE = Path.of("/srv/qianfan-crm/data/crm.sqlite");

  public static void main(String[] args) throws Exception {
    if (args.length != 1 || !Files.isRegularFile(DATABASE)
        || !DATABASE.toRealPath().equals(DATABASE)) {
      throw new IllegalArgumentException("Expected existing canonical CRM database and auth file");
    }
    Path auth = Path.of(args[0]);
    if (!Files.isRegularFile(auth)) throw new IllegalArgumentException("Missing authentication file");
    Class.forName("org.sqlite.JDBC");
    ServerCustomizer<Server> loopback = server -> {
      for (Connector connector : server.getConnectors()) {
        if (!(connector instanceof ServerConnector)) {
          throw new IllegalStateException("Unexpected connector type");
        }
        ((ServerConnector) connector).setHost("127.0.0.1");
        ((ServerConnector) connector).setIdleTimeout(60000);
      }
      server.setStopTimeout(10000);
      ((QueuedThreadPool) server.getThreadPool()).setMaxThreads(32);
    };
    HttpServer server = new HttpServer.Builder<Server>()
        .withPort(18531)
        .withHandler(new LocalService(new QianfanSqliteMeta()), Serialization.PROTOBUF)
        .withBasicAuthentication(auth.toString(), new String[] {"crm-admin"})
        .withServerCustomizers(List.of(loopback), Server.class)
        .build();
    Runtime.getRuntime().addShutdownHook(new Thread(server::stop));
    server.start();
    System.out.println("CRM remote SQLite ready on 127.0.0.1:18531 (SSH required)");
    server.join();
  }
}
