import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "liquido-ship-test-"));
const source = new URL("./run-daily.sh", import.meta.url);

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
}

function scenario(failRclone, missingMonitor = false) {
  const dir = join(root, missingMonitor ? "missing-monitor" : failRclone ? "failure" : "success");
  const bin = join(dir, "bin");
  const dumpDir = join(dir, "backups");
  const scriptDir = join(dir, "scripts");
  mkdirSync(bin, { recursive: true });
  mkdirSync(scriptDir);
  cpSync(source, join(scriptDir, "run-daily.sh"));
  chmodSync(join(scriptDir, "run-daily.sh"), 0o700);
  cpSync(new URL("./healthcheck-ping.sh", import.meta.url), join(scriptDir, "healthcheck-ping.sh"));
  chmodSync(join(scriptDir, "healthcheck-ping.sh"), 0o700);
  const healthFile = join(dir, "healthcheck-url");
  if (!missingMonitor) {
    writeFileSync(healthFile, "https://hc-ping.com/12345678-1234-1234-1234-123456789abc\n", { mode: 0o600 });
  }
  const events = join(dir, "events");
  executable(join(scriptDir, "backup.sh"), `
mkdir -p "$LIQUIDO_BACKUP_DIR"
dump="$LIQUIDO_BACKUP_DIR/liquido-20260926T030000Z-1.dump"
printf 'fixture' > "$dump"
printf '%s\\n' "$dump" > "$LIQUIDO_BACKUP_RESULT_FILE"
`);
  executable(join(bin, "curl"), `
config=$(cat)
case "$config" in
  *'/start"'*) echo start >> "$TEST_EVENTS" ;;
  *'/fail"'*) echo fail >> "$TEST_EVENTS" ;;
  *) echo success >> "$TEST_EVENTS" ;;
esac
`);
  executable(join(bin, "hostinger-backup-upload"), 'echo "upload:$2" >> "$TEST_EVENTS"');
  executable(join(bin, "rclone"), 'echo check >> "$TEST_EVENTS"; if [ "$FAIL_RCLONE" = 1 ]; then exit 42; fi');

  const result = spawnSync(join(scriptDir, "run-daily.sh"), [], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LIQUIDO_BACKUP_DIR: dumpDir,
      LIQUIDO_HEALTHCHECK_FILE: healthFile, TEST_EVENTS: events, FAIL_RCLONE: failRclone ? "1" : "0" },
    encoding: "utf8",
  });
  const calls = readFileSync(events, "utf8").trim().split("\n");
  assert.equal(existsSync(join(dumpDir, "liquido-20260926T030000Z-1.dump")), true);
  assert.equal(readdirSync(dumpDir).some((name) => name.startsWith(".upload.") || name.startsWith(".backup-result.")), false);
  assert.equal(calls.filter((call) => call === "check").length, 1);
  assert.deepEqual(calls.filter((call) => call.startsWith("upload:")),
    ["upload:daily/liquido-pilot/liquido-20260926T030000Z-1"]);
  assert.deepEqual(calls.filter((call) => ["start", "success", "fail"].includes(call)),
    missingMonitor ? [] : failRclone ? ["start", "fail"] : ["start", "success"]);
  assert.equal(result.status === 0, !failRclone && !missingMonitor, result.stderr);
  assert.equal(result.stdout.includes("Off-host backup verified"), !failRclone && !missingMonitor);
}

function operationsScenario(scenarioName) {
  const dir = join(root, `ops-${scenarioName}`);
  const bin = join(dir, "bin");
  const scriptDir = join(dir, "backup");
  mkdirSync(bin, { recursive: true });
  mkdirSync(scriptDir);
  for (const name of ["healthcheck-ping.sh", "run-ops-check.sh"]) {
    cpSync(new URL(`./${name}`, import.meta.url), join(scriptDir, name));
    chmodSync(join(scriptDir, name), 0o700);
  }
  const healthFile = join(dir, "ops-healthcheck-url");
  writeFileSync(healthFile, "https://hc-ping.com/12345678-1234-1234-1234-123456789abc\n", { mode: 0o600 });
  const events = join(dir, "events");
  executable(join(bin, "curl"), `
config=$(cat)
case "$config" in
  *'/start"'*) echo start >> "$TEST_EVENTS" ;;
  *'/fail"'*) echo fail >> "$TEST_EVENTS" ;;
  *) echo success >> "$TEST_EVENTS" ;;
esac
`);

  const stubScript = join(dir, "fetch-stub.mjs");
  writeFileSync(stubScript, `
const origTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => origTimeout(20);

globalThis.fetch = async (url, options = {}) => {
  const mode = process.env.OPS_SCENARIO;
  if (mode === "fetch-timeout") {
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {}, 1000);
      if (options.signal) {
        if (options.signal.aborted) {
          clearInterval(timer);
          reject(options.signal.reason);
        } else {
          options.signal.addEventListener("abort", () => {
            clearInterval(timer);
            reject(options.signal.reason);
          }, { once: true });
        }
      }
    });
  }
  if (mode === "http-503") {
    return { ok: false, status: 503 };
  }
  return { ok: true, status: 200 };
};
`);

  const dockerScript = join(bin, "docker");
  writeFileSync(dockerScript, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const events = process.env.TEST_EVENTS;
const scenario = process.env.OPS_SCENARIO;

const isWebExec = args.includes("exec") && args.includes("web");
const isOpsRun = args.includes("run") && args.includes("ops");

if (isWebExec) {
  appendFileSync(events, "web\\n");
  if (scenario === "web-stopped") {
    process.stderr.write("Container web is not running\\n");
    process.exit(1);
  }
  const nodeIdx = args.indexOf("node");
  const code = (nodeIdx !== -1 && args[nodeIdx + 1] === "-e") ? args[nodeIdx + 2] : "";
  const res = spawnSync(process.execPath, [
    "--import", ${JSON.stringify(stubScript)},
    "-e", code
  ], { stdio: "inherit", env: process.env });
  process.exit(res.status ?? 1);
}

if (isOpsRun) {
  appendFileSync(events, "db\\n");
  if (scenario === "db-failure") {
    process.stderr.write("DB check failed\\n");
    process.exit(1);
  }
  process.exit(0);
}

process.stderr.write("Unknown docker command: " + args.join(" ") + "\\n");
process.exit(1);
`, { mode: 0o700 });

  const result = spawnSync(join(scriptDir, "run-ops-check.sh"), [], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LIQUIDO_OPS_HEALTHCHECK_FILE: healthFile,
      TEST_EVENTS: events,
      OPS_SCENARIO: scenarioName,
    },
    encoding: "utf8",
  });

  const calls = readFileSync(events, "utf8").trim().split("\n");
  if (scenarioName === "success") {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Operations check passed\./);
    assert.equal(calls.includes("success"), true);
    assert.equal(calls.includes("fail"), false);
    assert.equal(calls.includes("web"), true);
    assert.equal(calls.includes("db"), true);
    assert.equal(calls.indexOf("web") < calls.indexOf("db"), true);
    assert.deepEqual(calls, ["start", "web", "db", "success"]);
  } else {
    assert.notEqual(result.status, 0);
    assert.equal(calls.includes("success"), false);
    assert.equal(calls.includes("fail"), true);
    if (["web-stopped", "http-503", "fetch-timeout"].includes(scenarioName)) {
      assert.equal(calls.includes("web"), true);
      assert.equal(calls.includes("db"), false);
      assert.deepEqual(calls, ["start", "web", "fail"]);
    } else if (scenarioName === "db-failure") {
      assert.equal(calls.includes("web"), true);
      assert.equal(calls.includes("db"), true);
      assert.equal(calls.indexOf("web") < calls.indexOf("db"), true);
      assert.deepEqual(calls, ["start", "web", "db", "fail"]);
    }
  }
}

function offsiteRestoreScenario() {
  const dir = join(root, "offsite-restore");
  const bin = join(dir, "bin");
  const scriptDir = join(dir, "backup");
  mkdirSync(bin, { recursive: true });
  mkdirSync(scriptDir);
  cpSync(new URL("./verify-offsite-restore.sh", import.meta.url), join(scriptDir, "verify-offsite-restore.sh"));
  chmodSync(join(scriptDir, "verify-offsite-restore.sh"), 0o700);
  const events = join(dir, "events");
  executable(join(scriptDir, "verify-restore.sh"), 'test -s "$1"; echo restore >> "$TEST_EVENTS"');
  executable(join(bin, "rclone"), 'printf fixture > "$3"; printf "%s\\n" "$3" > "$TEST_DOWNLOAD_PATH"; echo download >> "$TEST_EVENTS"');
  const downloadPath = join(dir, "download-path");
  const result = spawnSync(join(scriptDir, "verify-offsite-restore.sh"),
    ["liquido-20260926T030000Z-1"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_EVENTS: events,
        TEST_DOWNLOAD_PATH: downloadPath }, encoding: "utf8",
    });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(events, "utf8").trim().split("\n"), ["download", "restore"]);
  assert.equal(existsSync(readFileSync(downloadPath, "utf8").trim()), false);
  assert.match(result.stdout, /retrieval plus isolated database verification/);
  const invalid = spawnSync(join(scriptDir, "verify-offsite-restore.sh"), ["../../private"],
    { env: process.env, encoding: "utf8" });
  assert.equal(invalid.status, 2);
}

try {
  scenario(false);
  scenario(true);
  scenario(false, true);
  operationsScenario("success");
  operationsScenario("web-stopped");
  operationsScenario("http-503");
  operationsScenario("fetch-timeout");
  operationsScenario("db-failure");
  offsiteRestoreScenario();
  console.log("Backup shipping, operations alert and off-host restore paths passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
