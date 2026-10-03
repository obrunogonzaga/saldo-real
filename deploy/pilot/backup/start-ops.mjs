import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const password = readFileSync("/run/secrets/pilot_ops_db_password", "utf8").trimEnd();
if (!password) {
  throw new Error("The pilot operations database password secret is empty.");
}

const databaseUrl = new URL("postgresql://liquido_ops_readonly@db:5432/liquido");
databaseUrl.password = password;

const childEnvironment = { ...process.env };
delete childEnvironment.DATABASE_URL;
childEnvironment.OPERATIONS_DATABASE_URL = databaseUrl.toString();

const child = spawn("npm", ["run", "ops:report", "--", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: childEnvironment,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", () => {
  console.error("Could not start the pilot operations report.");
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
