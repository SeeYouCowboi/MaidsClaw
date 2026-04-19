#!/usr/bin/env node

import { spawn } from "node:child_process";

function printUsage() {
  console.error(
    "Usage: node scripts/run-with-hard-timeout.mjs <timeout-ms> [--] <command> [args...]",
  );
}

const cliArgs = process.argv.slice(2);
if (cliArgs.length < 2) {
  printUsage();
  process.exit(2);
}

const timeoutMs = Number.parseInt(cliArgs[0], 10);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  console.error(`[hard-timeout] invalid timeout: ${cliArgs[0]}`);
  process.exit(2);
}

const commandStartIndex = cliArgs[1] === "--" ? 2 : 1;
const command = cliArgs[commandStartIndex];
const commandArgs = cliArgs.slice(commandStartIndex + 1);

if (!command) {
  printUsage();
  process.exit(2);
}

const child = spawn(command, commandArgs, {
  stdio: "inherit",
  detached: process.platform !== "win32",
});

let timeoutTriggered = false;

const timeoutHandle = setTimeout(() => {
  timeoutTriggered = true;
  console.error(
    `[hard-timeout] command exceeded ${timeoutMs}ms and will be terminated`,
  );

  if (process.platform === "win32") {
    try {
      child.kill("SIGKILL");
      process.exit(124);
    } catch (error) {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/F"],
        { stdio: "inherit" },
      );
      killer.on("close", () => {
        if (error) {
          console.error("[hard-timeout] primary termination failed:", error);
        }
        process.exit(124);
      });
      killer.on("error", (killError) => {
        console.error("[hard-timeout] failed to terminate process:", killError);
        process.exit(124);
      });
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    console.error("[hard-timeout] failed to terminate process tree:", error);
  }
  process.exit(124);
}, timeoutMs);

child.on("error", (error) => {
  clearTimeout(timeoutHandle);
  console.error("[hard-timeout] failed to start command:", error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(timeoutHandle);

  if (timeoutTriggered) {
    return;
  }

  if (signal) {
    console.error(`[hard-timeout] command exited due to signal: ${signal}`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
