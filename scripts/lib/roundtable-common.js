const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_PROFILES = ["kimi", "deepseek"];
const DISABLED_PROFILES = new Set(["gohok"]);

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    "-",
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join("");
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function resolveClaudeBin(claudeBin) {
  if (process.platform !== "win32") return claudeBin;

  const requested = String(claudeBin || "claude").trim() || "claude";
  const normalized = requested.replace(/\//g, "\\").toLowerCase();
  const basename = path.basename(normalized);
  const wantsShim =
    basename === "claude" ||
    basename === "claude.cmd" ||
    basename === "claude.ps1";

  if (!wantsShim) return requested;

  const candidates = [];
  if (path.isAbsolute(requested)) {
    candidates.push(
      path.join(
        path.dirname(requested),
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe"
      )
    );
  }

  const appData = process.env.APPDATA;
  if (appData) {
    candidates.push(
      path.join(
        appData,
        "npm",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe"
      )
    );
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return requested;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function sanitizeName(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function redactValue(key, value) {
  const text = String(value ?? "");
  if (/TOKEN|KEY|SECRET|PASSWORD/i.test(key)) return text ? "<redacted>" : "";
  return text;
}

function redactedEnv(env = {}) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = redactValue(key, value);
  }
  return out;
}

function roleFor(profileName) {
  const roles = {
    kimi: "Kimi K3 (Coding Plan) - Primary Architect & Pragmatic Implementer. Focus on code architecture, modular design, practical trade-offs, and maintainability.",
    deepseek: "DeepSeek V4 Pro - Skeptic & Red-Teamer. Focus on security edge-cases, system complexity, performance risks, regression hazards, and cost.",
    gpt: "Gohok gpt-5.4 builder. Focus on product fit, practical implementation, and balanced tradeoffs.",
    local: "Local-router sanity checker. Focus on cheap validation, alternate routing assumptions, and practical constraints.",
  };
  return roles[profileName] || "Independent expert reviewer. Focus on the strongest recommendation and its risks.";
}

function extractClaudeText(stdout) {
  const raw = stdout.trim();
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.response === "string") return parsed.response;
    if (typeof parsed.content === "string") return parsed.content;
    if (Array.isArray(parsed.content)) {
      return parsed.content
        .map((part) => part.text || part.content || "")
        .join("\n")
        .trim();
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function extractJsonObject(text) {
  if (text && typeof text === "object" && !Array.isArray(text)) return text;
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function normalizeAction(text, from, validProfiles) {
  const parsed = extractJsonObject(text);
  const action = parsed && typeof parsed === "object" ? parsed : { public_message: text };
  const publicMessage = String(
    action.public_message || action.message || action.summary || text || ""
  ).trim();
  const directMessages = Array.isArray(action.direct_messages) ? action.direct_messages : [];

  return {
    public_message: publicMessage || "(empty response)",
    scoring_card: action.scoring_card || null,
    direct_messages: directMessages
      .map((item) => ({
        from,
        to: String(item.to || "").trim(),
        type: String(item.type || "question").trim(),
        message: String(item.message || item.content || "").trim(),
        requires_response: item.requires_response !== false,
      }))
      .filter((item) => item.message && validProfiles.includes(item.to) && item.to !== from),
    ready_to_finalize: Boolean(action.ready_to_finalize),
    confidence: action.confidence || null,
    parsed: Boolean(parsed),
  };
}

function formatParticipants(participants) {
  return participants
    .map((p) => `- ${p.name}: ${p.description || ""}; model=${p.model || ""}; role=${roleFor(p.name)}`)
    .join("\n");
}

function formatContext(messages, limit) {
  const recent = messages.slice(Math.max(0, messages.length - limit));
  if (!recent.length) return "(no prior meeting messages)";
  return recent
    .map((m) => {
      const target = m.to ? ` -> ${m.to}` : "";
      return `[${m.id}] ${m.from}${target} (${m.type}, ${m.phase}):\n${m.content}`;
    })
    .join("\n\n---\n\n");
}

function toolArgsForPolicy({ allowTools, allowReadTools }) {
  if (allowTools) return [];
  if (allowReadTools) return ["--tools", "Read,Glob,Grep"];
  return ["--tools", ""];
}

function validatePathWithinBase(inputPath, basePath, label) {
  const resolved = path.resolve(inputPath);
  const resolvedBase = path.resolve(basePath);
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be within ${resolvedBase}: ${resolved}`);
  }
  return resolved;
}

function resolveWorkspace(inputWorkspace) {
  return validatePathWithinBase(inputWorkspace || process.cwd(), process.cwd(), "--workspace");
}

module.exports = {
  DEFAULT_PROFILES,
  DISABLED_PROFILES,
  timestamp,
  homeDir,
  resolveClaudeBin,
  loadJson,
  writeFile,
  appendJsonl,
  sanitizeName,
  redactValue,
  redactedEnv,
  roleFor,
  extractClaudeText,
  extractJsonObject,
  normalizeAction,
  formatParticipants,
  formatContext,
  toolArgsForPolicy,
  validatePathWithinBase,
  resolveWorkspace,
};
