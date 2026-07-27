#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { DEFAULT_PROFILES, homeDir, resolveClaudeBin } = require("./lib/roundtable-common");

// ---------------------------------------------------------------------------
// Preflight checks — give users clear guidance instead of cryptic errors
// ---------------------------------------------------------------------------

function checkNodeVersion() {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) {
    console.error(
      `\n  ✗ Node.js >= 18 is required (found ${process.version}).\n` +
      `    Install a recent version: https://nodejs.org/\n`
    );
    return false;
  }
  return true;
}

function checkClaudeCli(claudeBin) {
  const resolved = resolveClaudeBin(claudeBin);
  try {
    execFileSync(resolved, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      windowsHide: true,
    });
    return true;
  } catch {
    console.error(
      `\n  ✗ Claude Code CLI not found ("${resolved}").\n` +
      `    This tool uses Claude Code as its execution engine.\n` +
      `    Install it:  npm install -g @anthropic-ai/claude-code\n` +
      `    Then sign in: claude login\n`
    );
    return false;
  }
}

function checkProfiles(profileNames) {
  const profilesPath = path.join(homeDir(), ".claude", "api-profiles.json");
  if (!fs.existsSync(profilesPath)) {
    console.error(
      `\n  ✗ API profiles not found at ${profilesPath}\n` +
      `    Create this file with your model configurations.\n` +
      `    See: api-profiles.example.json in this repository.\n`
    );
    return false;
  }

  let profiles;
  try {
    profiles = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
  } catch (err) {
    console.error(`\n  ✗ Failed to parse ${profilesPath}: ${err.message}\n`);
    return false;
  }

  const missing = profileNames.filter((name) => !profiles[name]);
  if (missing.length) {
    console.error(
      `\n  ✗ Missing profile(s) in ${profilesPath}: ${missing.join(", ")}\n` +
      `    Available profiles: ${Object.keys(profiles).join(", ") || "(none)"}\n` +
      `    Add the missing profile(s) or use --profiles to specify existing ones.\n`
    );
    return false;
  }

  return true;
}

function runPreflight(profileNames, claudeBin) {
  console.log("model-roundtable — preflight checks\n");
  const results = [
    ["Node.js >= 18", checkNodeVersion()],
    ["Claude Code CLI", checkClaudeCli(claudeBin)],
    ["API profiles", checkProfiles(profileNames)],
  ];

  for (const [label, ok] of results) {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  }

  const allOk = results.every(([, ok]) => ok);
  if (allOk) {
    console.log("\n  All checks passed. Ready to run.\n");
  } else {
    console.log("\n  Some checks failed. Fix the issues above and try again.\n");
  }
  return allOk;
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);

  // Quick flags that don't need full parsing
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
model-roundtable — structured multi-model debate with adversarial personas

Usage:
  model-roundtable --topic "..."           Interactive debate (V2, default)
  model-roundtable --batch --topic "..."   Batch debate (V1, fixed rounds)
  model-roundtable --preflight             Check prerequisites
  model-roundtable --help                  Show this help

All other options are passed through to the underlying script.
Run with --help after --batch to see batch-specific options.

Examples:
  model-roundtable --topic "Microservices vs monolith for our auth system"
  model-roundtable --topic "..." --profiles kimi,deepseek --cycles 3
  model-roundtable --topic "..." --allow-read-tools --dry-run
  model-roundtable --batch --topic "..." --rounds 3
`);
    return;
  }

  // Determine which profiles will be used (for preflight)
  let profileNames = DEFAULT_PROFILES;
  const profilesIdx = argv.indexOf("--profiles");
  if (profilesIdx >= 0 && profilesIdx + 1 < argv.length) {
    profileNames = argv[profilesIdx + 1].split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Determine claude binary
  let claudeBin = "claude";
  const claudeBinIdx = argv.indexOf("--claude-bin");
  if (claudeBinIdx >= 0 && claudeBinIdx + 1 < argv.length) {
    claudeBin = argv[claudeBinIdx + 1];
  }

  // Preflight-only mode
  if (argv.includes("--preflight")) {
    const ok = runPreflight(profileNames, claudeBin);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  // Run preflight silently on first real invocation (skip for dry-run)
  if (!argv.includes("--dry-run")) {
    if (!checkNodeVersion()) { process.exitCode = 1; return; }
    if (!checkClaudeCli(claudeBin)) { process.exitCode = 1; return; }
    if (!checkProfiles(profileNames)) { process.exitCode = 1; return; }
  }

  // Determine which script to run
  const isBatch = argv.includes("--batch");
  const filteredArgv = argv.filter((a) => a !== "--batch");
  const scriptName = isBatch ? "roundtable.js" : "interactive-roundtable.js";
  const scriptPath = path.join(__dirname, scriptName);

  // Re-exec with the chosen script, passing through all args
  const { fork } = require("child_process");
  const child = fork(scriptPath, filteredArgv, {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

main();
