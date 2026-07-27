#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  DEFAULT_PROFILES,
  DISABLED_PROFILES,
  timestamp,
  homeDir,
  resolveClaudeBin,
  loadJson,
  writeFile,
  sanitizeName,
  redactedEnv,
  roleFor,
  extractClaudeText,
  toolArgsForPolicy,
  resolveWorkspace,
  validatePathWithinBase,
} = require("./lib/roundtable-common");

const TEMP_DIRS = new Set();

function cleanupTempDirs() {
  for (const dir of TEMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  TEMP_DIRS.clear();
}

["exit", "SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => {
    cleanupTempDirs();
    if (signal !== "exit") process.exit(1);
  });
});

function usage() {
  console.log(`claude-roundtable

Usage:
  node roundtable.js --topic "..." [options]
  node roundtable.js --topic-file topic.md [options]

Options:
  --profiles <list>       Comma-separated profile names. Default: ${DEFAULT_PROFILES.join(",")}
  --rounds <n>            1, 2, or 3. Default: 3
  --out <dir>             Output directory. Default: ./roundtable-runs/<timestamp>
  --workspace <dir>       Working directory for Claude calls. Default: current directory
  --claude-bin <path>     Claude executable. Default: claude
  --max-budget-usd <n>    Pass a spend cap to claude -p
  --allow-tools           Allow Claude default tools. Default: discussion-only, no tools
  --allow-read-tools      Allow read-only tools (Read, Glob, Grep) for workspace inspection
  --dry-run               Write prompts and metadata without calling Claude
  --help                  Show this help
`);
}

function parseArgs(argv) {
  const args = {
    profiles: DEFAULT_PROFILES.join(","),
    rounds: "3",
    workspace: process.cwd(),
    claudeBin: "claude",
    allowTools: false,
    allowReadTools: false,
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };

    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--topic") args.topic = next();
    else if (arg === "--topic-file") args.topicFile = next();
    else if (arg === "--profiles") args.profiles = next();
    else if (arg === "--rounds") args.rounds = next();
    else if (arg === "--out") args.out = next();
    else if (arg === "--workspace") args.workspace = next();
    else if (arg === "--claude-bin") args.claudeBin = next();
    else if (arg === "--max-budget-usd") args.maxBudgetUsd = next();
    else if (arg === "--allow-tools") args.allowTools = true;
    else if (arg === "--allow-read-tools") args.allowReadTools = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.allowTools && args.allowReadTools) {
    throw new Error("--allow-tools and --allow-read-tools are mutually exclusive.");
  }

  return args;
}

function renderOutputs(outputs, excludeProfile = null) {
  return outputs
    .filter((item) => item.profile !== excludeProfile)
    .map((item) => `## ${item.profile} (${item.round})\n\n${item.text.trim()}`)
    .join("\n\n---\n\n");
}

function promptFor({ phase, profileName, topic, priorOutputs }) {
  const role = roleFor(profileName);
  if (phase === "proposal") {
    return `You are one participant in a Codex-moderated multi-model engineering roundtable.

Topic:
${topic}

Your participant profile: ${profileName}
Your role: ${role}

Work independently. Do not assume other participants will agree. Ground your analysis on code references where applicable.

Return concise Markdown with exactly these sections:
## Recommendation
## Reasoning
## Scoring Card
- Architecture Extensibility (1-10):
- Safety / Low Risk (1-10):
- Implementation Ease (1-10):
- Testability (1-10):
## Risks
## What Would Change My Mind
`;
  }

  if (phase === "critique") {
    return `You are one participant in a Codex-moderated multi-model engineering roundtable.

Topic:
${topic}

Your participant profile: ${profileName}
Your role: ${role}

Other participant outputs:
${renderOutputs(priorOutputs, profileName)}

Critique the proposals. Be specific about weak assumptions and useful ideas. Ground your argument in specific files or modules if relevant.

Return concise Markdown with exactly these sections:
## Strongest Points
## Weakest Assumptions
## Missing Risks
## What The Final Answer Should Preserve
## What The Final Answer Should Reject
`;
  }

  return `You are one participant in a Codex-moderated multi-model engineering roundtable.

Topic:
${topic}

Your participant profile: ${profileName}
Your role: ${role}

Roundtable so far:
${renderOutputs(priorOutputs)}

Give your final revised position. You may change your mind if another participant made a stronger argument.

Return concise Markdown with exactly these sections:
## Final Recommendation
## Why This Beats Alternatives
## Final Scoring Card
- Architecture Extensibility (1-10):
- Safety / Low Risk (1-10):
- Implementation Ease (1-10):
- Testability (1-10):
## Remaining Risks
## Execution Steps
## Open Questions
`;
}

function runClaude({ claudeBin, prompt, profile, workspace, runDir, phase, profileName, allowTools, allowReadTools, maxBudgetUsd, dryRun }) {
  return new Promise((resolve, reject) => {
    const safeProfile = sanitizeName(profileName);
    const safePhase = sanitizeName(phase);
    const promptPath = path.join(runDir, "prompts", `${safePhase}-${safeProfile}.md`);
    const responsePath = path.join(runDir, "responses", `${safePhase}-${safeProfile}.md`);
    const rawPath = path.join(runDir, "raw", `${safePhase}-${safeProfile}.txt`);
    writeFile(promptPath, prompt);

    if (dryRun) {
      const text = `[dry-run] Would call Claude profile ${profileName} for ${phase}.`;
      writeFile(responsePath, `${text}\n`);
      writeFile(rawPath, `${text}\n`);
      resolve({ profile: profileName, phase, round: phase, text, ok: true, dryRun: true });
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `claude-roundtable-${safeProfile}-`));
    TEMP_DIRS.add(tempDir);
    const settingsPath = path.join(tempDir, "settings.json");
    const settings = {
      env: profile.env || {},
      model: profile.model,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
    try {
      fs.chmodSync(settingsPath, 0o600);
    } catch {}

    const args = [
      "-p",
      prompt,
      "--settings",
      settingsPath,
      "--output-format",
      "json",
      "--no-session-persistence",
      ...toolArgsForPolicy({ allowTools, allowReadTools }),
    ];
    if (maxBudgetUsd) args.push("--max-budget-usd", String(maxBudgetUsd));

    const resolvedClaudeBin = resolveClaudeBin(claudeBin);
    let resolved = false;
    const child = spawn(resolvedClaudeBin, args, {
      cwd: workspace,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    function finish(error, code) {
      if (resolved) return;
      resolved = true;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
      TEMP_DIRS.delete(tempDir);

      if (error) {
        reject(error);
        return;
      }

      const raw = [stdout, stderr ? `\n[stderr]\n${stderr}` : ""].join("");
      const text = code === 0 ? extractClaudeText(stdout) : `Command failed with exit code ${code}.\n\n${stderr.trim()}`;
      writeFile(rawPath, raw);
      writeFile(responsePath, `${text.trim()}\n`);
      resolve({ profile: profileName, phase, round: phase, text, ok: code === 0, exitCode: code });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += `\n${error.stack || error.message}`;
      finish(error);
    });
    child.on("close", (code) => finish(null, code));
  });
}

function transcript({ topic, participants, outputs, metadata }) {
  const chunks = [];
  chunks.push("# Claude Roundtable Transcript\n");
  chunks.push("## Topic\n");
  chunks.push(`${topic.trim()}\n`);
  chunks.push("## Participants\n");
  for (const item of participants) {
    chunks.push(`- ${item.name}: ${item.description || ""} / model=${item.model || ""}`);
  }
  chunks.push("\n## Metadata\n");
  chunks.push("```json");
  chunks.push(JSON.stringify(metadata, null, 2));
  chunks.push("```\n");
  for (const out of outputs) {
    chunks.push(`## ${out.phase}: ${out.profile}\n`);
    if (!out.ok) chunks.push(`Status: failed (exitCode=${out.exitCode})\n`);
    chunks.push(out.text.trim() || "(empty response)");
    chunks.push("");
  }
  chunks.push("## Codex Synthesis Checklist\n");
  chunks.push("- Identify the best recommendation and why it wins.");
  chunks.push("- Preserve high-signal disagreements.");
  chunks.push("- Call out unverified claims.");
  chunks.push("- Produce a concrete execution plan.");
  return `${chunks.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }

  let topic = args.topic || "";
  if (args.topicFile) {
    const topicFilePath = validatePathWithinBase(args.topicFile, process.cwd(), "--topic-file");
    topic = fs.readFileSync(topicFilePath, "utf8");
  }
  if (!topic.trim()) throw new Error("Provide --topic or --topic-file.");

  const rounds = Number(args.rounds);
  if (!Number.isInteger(rounds) || !Number.isFinite(rounds) || !Number.isInteger(rounds) || ![1, 2, 3].includes(rounds)) {
    throw new Error("--rounds must be 1, 2, or 3.");
  }

  const workspace = resolveWorkspace(args.workspace);

  const profilesPath = path.join(homeDir(), ".claude", "api-profiles.json");
  const profiles = loadJson(profilesPath);
  const requestedProfiles = args.profiles.split(",").map((p) => p.trim()).filter(Boolean);
  if (requestedProfiles.length === 0) throw new Error("Provide at least one profile.");
  const missing = requestedProfiles.filter((name) => !profiles[name]);
  if (missing.length) throw new Error(`Missing profile(s): ${missing.join(", ")}`);
  const disabled = requestedProfiles.filter((name) => DISABLED_PROFILES.has(name));
  if (disabled.length) throw new Error(`Temporarily disabled profile(s): ${disabled.join(", ")}. Use gpt for high-capability review until Opus is re-enabled.`);

  const runDir = validatePathWithinBase(
    args.out || path.join(process.cwd(), "roundtable-runs", timestamp()),
    process.cwd(),
    "--out"
  );
  fs.mkdirSync(runDir, { recursive: true });

  const participants = requestedProfiles.map((name) => ({
    name,
    description: profiles[name].description,
    model: profiles[name].model,
    env: redactedEnv(profiles[name].env || {}),
  }));
  const metadata = {
    createdAt: new Date().toISOString(),
    workspace,
    rounds,
    dryRun: args.dryRun,
    allowTools: args.allowTools,
    allowReadTools: args.allowReadTools,
    profiles: participants,
  };
  writeFile(path.join(runDir, "participants.json"), JSON.stringify(metadata, null, 2) + "\n");

  console.log(`Roundtable run: ${runDir}`);
  console.log(`Profiles: ${requestedProfiles.join(", ")}`);
  console.log(`Rounds: ${rounds}${args.dryRun ? " (dry-run)" : ""}`);

  const outputs = [];
  for (const phase of ["proposal", "critique", "revision"].slice(0, rounds)) {
    console.log(`\n== ${phase} ==`);
    const phaseInputs = outputs.slice();
    for (const profileName of requestedProfiles) {
      process.stdout.write(`- ${profileName}... `);
      const prompt = promptFor({ phase, profileName, topic, priorOutputs: phaseInputs });
      const result = await runClaude({
        claudeBin: args.claudeBin,
        prompt,
        profile: profiles[profileName],
        workspace,
        runDir,
        phase,
        profileName,
        allowTools: args.allowTools,
        allowReadTools: args.allowReadTools,
        maxBudgetUsd: args.maxBudgetUsd,
        dryRun: args.dryRun,
      });
      outputs.push(result);
      console.log(result.ok ? "ok" : "failed");
    }
  }

  const transcriptPath = path.join(runDir, "roundtable-transcript.md");
  writeFile(transcriptPath, transcript({ topic, participants, outputs, metadata }));
  console.log(`\nTranscript: ${transcriptPath}`);
  console.log("Next: read the transcript and synthesize the final recommendation as Codex.");
}

main().catch((error) => {
  console.error(error.message || error);
  cleanupTempDirs();
  process.exitCode = 1;
});
