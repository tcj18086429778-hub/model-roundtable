#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const {
  DEFAULT_PROFILES,
  DISABLED_PROFILES,
  timestamp,
  homeDir,
  resolveClaudeBin,
  loadJson,
  writeFile,
  appendJsonl,
  sanitizeName,
  redactedEnv,
  roleFor,
  extractClaudeText,
  extractJsonObject,
  normalizeAction,
  formatParticipants,
  formatContext,
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
  console.log(`interactive-claude-roundtable

Usage:
  node interactive-roundtable.js --topic "..." [options]
  node interactive-roundtable.js --topic-file topic.md [options]

Options:
  --profiles <list>          Comma-separated profile names. Default: ${DEFAULT_PROFILES.join(",")}
  --cycles <n>               Crossfire cycles after opening statements. Default: 2
  --max-directed-turns <n>   Max routed direct-message responses. Default: 12
  --context-messages <n>     Recent messages included in prompts. Default: 30
  --out <dir>                Output directory. Default: ./roundtable-runs/interactive-<timestamp>
  --workspace <dir>          Working directory for Claude calls. Default: current directory
  --claude-bin <path>        Claude executable. Default: claude
  --max-budget-usd <n>       Pass a spend cap to each claude -p call
  --allow-tools              Allow Claude default tools. Default: discussion-only, no tools
  --allow-read-tools         Allow read-only tools (Read, Glob, Grep) for workspace inspection
  --dry-run                  Write prompts, messages, and state without calling Claude
  --help                     Show this help
`);
}

function parseArgs(argv) {
  const args = {
    profiles: DEFAULT_PROFILES.join(","),
    cycles: "2",
    maxDirectedTurns: "12",
    contextMessages: "30",
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
    else if (arg === "--cycles") args.cycles = next();
    else if (arg === "--max-directed-turns") args.maxDirectedTurns = next();
    else if (arg === "--context-messages") args.contextMessages = next();
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

function jsonInstruction(maxDirectMessages) {
  return `Return ONLY valid JSON with this shape:
{
  "public_message": "Markdown statement visible to the whole meeting. Include rationale and ground your analysis on code references where applicable.",
  "scoring_card": {
    "architecture_extensibility": 8,
    "low_breaking_risk": 7,
    "implementation_ease": 8,
    "testability": 9
  },
  "direct_messages": [
    {
      "to": "one participant profile name",
      "type": "question | challenge | answer | support | clarification",
      "message": "A concrete message to that participant.",
      "requires_response": true
    }
  ],
  "ready_to_finalize": false,
  "confidence": "low | medium | high"
}

Rules:
- Fill out scoring_card with 1-10 scores for key metrics.
- Use at most ${maxDirectMessages} direct_messages.
- Do not include secrets or API keys.
- Keep public_message concise but substantive.`;
}

function promptForOpening({ topic, participant, participants }) {
  return `You are a stateful participant in an interactive Codex-moderated multi-model roundtable.

Topic:
${topic}

Participants:
${formatParticipants(participants)}

You are: ${participant.name}
Your role: ${roleFor(participant.name)}

Give your opening position. You may directly challenge or question another participant if it would improve the final decision.

${jsonInstruction(2)}
`;
}

function promptForCrossfire({ topic, participant, participants, messages, contextLimit, cycle }) {
  return `Continue the same interactive roundtable from your persistent session.

Topic:
${topic}

Participants:
${formatParticipants(participants)}

You are: ${participant.name}
Your role: ${roleFor(participant.name)}
Crossfire cycle: ${cycle}

Recent meeting context:
${formatContext(messages, contextLimit)}

Either advance the discussion with a direct question/challenge to one participant, or state that the meeting is ready to finalize.

${jsonInstruction(1)}
`;
}

function promptForDirectedMessage({ topic, participant, participants, messages, contextLimit, directed }) {
  return `Continue the same interactive roundtable from your persistent session.

Topic:
${topic}

Participants:
${formatParticipants(participants)}

You are: ${participant.name}
Your role: ${roleFor(participant.name)}

You received this direct message from ${directed.from}:
Type: ${directed.type}
Message:
${directed.message}

Recent meeting context:
${formatContext(messages, contextLimit)}

Respond to the direct message. You may send at most one follow-up direct message if it is necessary.

${jsonInstruction(1)}
`;
}

function promptForFinal({ topic, participant, participants, messages, contextLimit }) {
  return `Finalize your position in this interactive roundtable.

Topic:
${topic}

Participants:
${formatParticipants(participants)}

You are: ${participant.name}
Your role: ${roleFor(participant.name)}

Recent meeting context:
${formatContext(messages, contextLimit)}

Give your final recommendation for Codex to synthesize. Do not send direct messages now.

Return ONLY valid JSON:
{
  "public_message": "Markdown with: final recommendation, strongest reason, biggest risk, execution steps, open questions.",
  "direct_messages": [],
  "ready_to_finalize": true,
  "confidence": "low | medium | high"
}
`;
}

function dryRunText(label, participant, validProfiles) {
  const other = validProfiles.find((name) => name !== participant.name) || null;
  if (label === "opening" && other) {
    return JSON.stringify({
      public_message: `[dry-run] ${participant.name} opening position.`,
      direct_messages: participant.name === validProfiles[0] ? [{
        to: other,
        type: "challenge",
        message: `[dry-run] ${participant.name} challenges ${other} to test routed responses.`,
        requires_response: true,
      }] : [],
      ready_to_finalize: false,
      confidence: "medium",
    });
  }
  return JSON.stringify({
    public_message: `[dry-run] ${participant.name} response for ${label}.`,
    direct_messages: [],
    ready_to_finalize: label.startsWith("final"),
    confidence: "medium",
  });
}

function runClaude({ claudeBin, prompt, profile, participant, workspace, runDir, label, allowTools, allowReadTools, maxBudgetUsd, dryRun }) {
  return new Promise((resolve, reject) => {
    const safeProfile = sanitizeName(participant.name);
    const safeLabel = sanitizeName(label);
    const promptPath = path.join(runDir, "prompts", `${safeLabel}-${safeProfile}.md`);
    const responsePath = path.join(runDir, "responses", `${safeLabel}-${safeProfile}.md`);
    const rawPath = path.join(runDir, "raw", `${safeLabel}-${safeProfile}.txt`);
    writeFile(promptPath, prompt);

    if (dryRun) {
      const text = dryRunText(label, participant, participant.validProfiles);
      writeFile(responsePath, `${text}\n`);
      writeFile(rawPath, `${text}\n`);
      participant.turns += 1;
      resolve({ ok: true, text, dryRun: true });
      return;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `claude-irt-${safeProfile}-`));
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
      "--name",
      participant.sessionName,
      ...toolArgsForPolicy({ allowTools, allowReadTools }),
    ];
    if (participant.turns === 0) args.push("--session-id", participant.sessionId);
    else args.push("--resume", participant.sessionId);
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
      if (code === 0) participant.turns += 1;
      resolve({ ok: code === 0, text, exitCode: code });
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

function renderTranscript({ topic, participants, messages, state }) {
  const chunks = [];
  chunks.push("# Interactive Claude Roundtable Transcript\n");
  chunks.push("## Topic\n");
  chunks.push(`${topic.trim()}\n`);
  chunks.push("## Participants\n");
  for (const p of participants) {
    chunks.push(`- ${p.name}: ${p.description || ""}; model=${p.model || ""}; session=${p.sessionId}`);
  }
  chunks.push("\n## State\n");
  chunks.push("```json");
  chunks.push(JSON.stringify(state, null, 2));
  chunks.push("```\n");
  chunks.push("## Messages\n");
  for (const m of messages) {
    const target = m.to ? ` -> ${m.to}` : "";
    chunks.push(`### ${m.id}. ${m.from}${target} (${m.type}, ${m.phase})\n`);
    chunks.push(m.content.trim() || "(empty)");
    chunks.push("");
  }
  chunks.push("## Codex Synthesis Checklist\n");
  chunks.push("- Identify the strongest final recommendation.");
  chunks.push("- Resolve direct disagreements with evidence.");
  chunks.push("- Call out claims that need local verification.");
  chunks.push("- Produce a concrete execution plan and open questions.");
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

  const cycles = Number(args.cycles);
  const maxDirectedTurns = Number(args.maxDirectedTurns);
  const contextMessages = Number(args.contextMessages);
  if (!Number.isInteger(cycles) || cycles < 0 || cycles > 10) throw new Error("--cycles must be an integer between 0 and 10.");
  if (!Number.isInteger(maxDirectedTurns) || maxDirectedTurns < 0 || maxDirectedTurns > 100) throw new Error("--max-directed-turns must be an integer between 0 and 100.");
  if (!Number.isInteger(contextMessages) || contextMessages < 1 || contextMessages > 200) throw new Error("--context-messages must be an integer between 1 and 200.");

  const workspace = resolveWorkspace(args.workspace);

  const profilesPath = path.join(homeDir(), ".claude", "api-profiles.json");
  const profiles = loadJson(profilesPath);
  const requestedProfiles = args.profiles.split(",").map((p) => p.trim()).filter(Boolean);
  if (requestedProfiles.length === 0) throw new Error("Provide at least one profile.");
  const missing = requestedProfiles.filter((name) => !profiles[name]);
  if (missing.length) throw new Error(`Missing profile(s): ${missing.join(", ")}`);
  const disabled = requestedProfiles.filter((name) => DISABLED_PROFILES.has(name));
  if (disabled.length) throw new Error(`Temporarily disabled profile(s): ${disabled.join(", ")}. Use gpt for high-capability review until Opus is re-enabled.`);

  const meetingId = `irt-${timestamp()}-${crypto.randomUUID().slice(0, 8)}`;
  const runDir = validatePathWithinBase(
    args.out || path.join(process.cwd(), "roundtable-runs", `interactive-${timestamp()}`),
    process.cwd(),
    "--out"
  );
  fs.mkdirSync(runDir, { recursive: true });

  const participants = requestedProfiles.map((name) => ({
    name,
    description: profiles[name].description,
    model: profiles[name].model,
    env: redactedEnv(profiles[name].env || {}),
    sessionId: crypto.randomUUID(),
    sessionName: `roundtable-${meetingId}-${name}`,
    turns: 0,
    validProfiles: requestedProfiles,
  }));
  const participantByName = Object.fromEntries(participants.map((p) => [p.name, p]));
  const messages = [];
  const queue = [];
  let messageId = 1;
  let directedTurns = 0;

  const state = {
    mode: "interactive",
    meetingId,
    createdAt: new Date().toISOString(),
    workspace,
    dryRun: args.dryRun,
    allowTools: args.allowTools,
    allowReadTools: args.allowReadTools,
    cycles,
    maxDirectedTurns,
    contextMessages,
    participants: participants.map((p) => ({
      name: p.name,
      description: p.description,
      model: p.model,
      env: p.env,
      sessionId: p.sessionId,
      sessionName: p.sessionName,
    })),
  };
  writeFile(path.join(runDir, "state.json"), JSON.stringify(state, null, 2) + "\n");

  const persist = () => {
    writeFile(path.join(runDir, "state.json"), JSON.stringify({
      ...state,
      updatedAt: new Date().toISOString(),
      messageCount: messages.length,
      queuedMessages: queue.length,
      directedTurns,
      participantTurns: Object.fromEntries(participants.map((p) => [p.name, p.turns])),
    }, null, 2) + "\n");
    writeFile(path.join(runDir, "interactive-transcript.md"), renderTranscript({ topic, participants, messages, state }));
  };

  const addPublicMessage = (from, phase, content, meta = {}) => {
    const message = {
      id: messageId++,
      ts: new Date().toISOString(),
      from,
      to: null,
      type: "public",
      phase,
      content,
      ...meta,
    };
    messages.push(message);
    appendJsonl(path.join(runDir, "messages.jsonl"), message);
    return message;
  };

  const addDirectMessage = (directed, phase) => {
    const message = {
      id: messageId++,
      ts: new Date().toISOString(),
      from: directed.from,
      to: directed.to,
      type: directed.type || "question",
      phase,
      requires_response: directed.requires_response !== false,
      content: directed.message,
    };
    messages.push(message);
    appendJsonl(path.join(runDir, "messages.jsonl"), message);
    if (message.requires_response) queue.push(message);
    return message;
  };

  const callParticipant = async (participant, label, prompt, phase, isFinal = false) => {
    process.stdout.write(`- ${participant.name} (${label})... `);
    let result;
    try {
      result = await runClaude({
        claudeBin: args.claudeBin,
        prompt,
        profile: profiles[participant.name],
        participant,
        workspace,
        runDir,
        label,
        allowTools: args.allowTools,
        allowReadTools: args.allowReadTools,
        maxBudgetUsd: args.maxBudgetUsd,
        dryRun: args.dryRun,
      });
    } catch (error) {
      console.log("failed");
      addPublicMessage(participant.name, phase, `Spawn error: ${error.message || error}`, { status: "failed", error: error.message || String(error) });
      persist();
      return;
    }
    console.log(result.ok ? "ok" : "failed");

    if (!result.ok) {
      addPublicMessage(participant.name, phase, result.text, { status: "failed", exitCode: result.exitCode });
      persist();
      return;
    }

    const action = normalizeAction(result.text, participant.name, requestedProfiles);
    if (isFinal) {
      if (action.direct_messages.length > 0) {
        console.warn(`WARN: ${participant.name} sent direct_messages in final phase; ignoring them.`);
      }
      action.direct_messages = [];
    }
    addPublicMessage(participant.name, phase, action.public_message, {
      parsedAction: action.parsed,
      confidence: action.confidence,
      readyToFinalize: action.ready_to_finalize,
    });
    for (const directed of action.direct_messages) addDirectMessage(directed, phase);
    persist();
  };

  const processQueue = async (phase) => {
    while (queue.length && directedTurns < maxDirectedTurns) {
      const directed = queue.shift();
      const target = participantByName[directed.to];
      if (!target) continue;
      directedTurns += 1;
      const prompt = promptForDirectedMessage({
        topic,
        participant: target,
        participants,
        messages,
        contextLimit: contextMessages,
        directed,
      });
      await callParticipant(target, `${phase}-reply-${directed.id}`, prompt, phase);
    }
  };

  console.log(`Interactive roundtable run: ${runDir}`);
  console.log(`Meeting: ${meetingId}`);
  console.log(`Profiles: ${requestedProfiles.join(", ")}`);
  console.log(`Cycles: ${cycles}; max directed turns: ${maxDirectedTurns}${args.dryRun ? " (dry-run)" : ""}`);

  console.log("\n== opening ==");
  for (const participant of participants) {
    await callParticipant(participant, "opening", promptForOpening({ topic, participant, participants }), "opening");
  }
  await processQueue("opening");

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    console.log(`\n== crossfire ${cycle} ==`);
    for (const participant of participants) {
      const prompt = promptForCrossfire({
        topic,
        participant,
        participants,
        messages,
        contextLimit: contextMessages,
        cycle,
      });
      await callParticipant(participant, `crossfire-${cycle}`, prompt, `crossfire-${cycle}`);
    }
    await processQueue(`crossfire-${cycle}`);
  }

  console.log("\n== final ==");
  for (const participant of participants) {
    const prompt = promptForFinal({
      topic,
      participant,
      participants,
      messages,
      contextLimit: contextMessages,
    });
    await callParticipant(participant, "final", prompt, "final", true);
  }

  persist();
  console.log(`\nTranscript: ${path.join(runDir, "interactive-transcript.md")}`);
  console.log(`Messages:   ${path.join(runDir, "messages.jsonl")}`);
  console.log("Next: read the transcript and synthesize the final recommendation as Codex.");
}

main().catch((error) => {
  console.error(error.message || error);
  cleanupTempDirs();
  process.exitCode = 1;
});
