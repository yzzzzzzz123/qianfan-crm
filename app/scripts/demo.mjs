process.env.DEMO_MODE = "true";
process.env.DB_PATH ||= "data/demo.sqlite";
const { start } = await import("../server/index.mjs");
start();
