const assert = require("assert");
const path = require("path");
const os = require("os");
const { describe, it } = require("node:test");
const {
  DEFAULT_PROFILES,
  DISABLED_PROFILES,
  timestamp,
  homeDir,
  resolveClaudeBin,
  redactValue,
  redactedEnv,
  roleFor,
  extractClaudeText,
  extractJsonObject,
  normalizeAction,
  toolArgsForPolicy,
  validatePathWithinBase,
  resolveWorkspace,
} = require("./roundtable-common");

describe("roundtable-common", () => {
  describe("constants", () => {
    it("has expected defaults", () => {
      assert.deepStrictEqual(DEFAULT_PROFILES, ["kimi", "deepseek"]);
      assert(DISABLED_PROFILES.has("gohok"));
    });
  });

  describe("timestamp", () => {
    it("returns a 15-character string with date and time", () => {
      const ts = timestamp();
      assert.strictEqual(ts.length, 15);
      assert.match(ts, /^\d{8}-\d{6}$/);
    });
  });

  describe("homeDir", () => {
    it("returns a non-empty string", () => {
      assert.strictEqual(typeof homeDir(), "string");
      assert(homeDir().length > 0);
    });
  });

  describe("resolveClaudeBin", () => {
    it("returns the input on non-Windows platforms", () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "linux" });
      try {
        assert.strictEqual(resolveClaudeBin("claude"), "claude");
        assert.strictEqual(resolveClaudeBin("/usr/local/bin/claude"), "/usr/local/bin/claude");
      } finally {
        if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
      }
    });

    it("resolves to claude.exe on Windows when shim exists", () => {
      if (process.platform !== "win32") return;
      const resolved = resolveClaudeBin("claude");
      assert.strictEqual(typeof resolved, "string");
      assert(resolved.length > 0);
    });
  });

  describe("redactValue", () => {
    it("redacts secret-shaped values", () => {
      assert.strictEqual(redactValue("ANTHROPIC_API_KEY", "sk-ant-123"), "<redacted>");
      assert.strictEqual(redactValue("api_token", "abc"), "<redacted>");
      assert.strictEqual(redactValue("password", "hunter2"), "<redacted>");
      assert.strictEqual(redactValue("client_secret", "shh"), "<redacted>");
    });

    it("returns non-secret values unchanged", () => {
      assert.strictEqual(redactValue("MODEL", "claude-sonnet-5"), "claude-sonnet-5");
      assert.strictEqual(redactValue("region", "us-east-1"), "us-east-1");
    });

    it("returns empty string for empty secret values", () => {
      assert.strictEqual(redactValue("API_KEY", ""), "");
      assert.strictEqual(redactValue("API_KEY", null), "");
      assert.strictEqual(redactValue("API_KEY", undefined), "");
    });
  });

  describe("redactedEnv", () => {
    it("redacts secrets but preserves non-secrets", () => {
      const env = {
        ANTHROPIC_API_KEY: "sk-ant-123",
        MODEL: "claude-sonnet-5",
        password: "secret",
      };
      const redacted = redactedEnv(env);
      assert.strictEqual(redacted.ANTHROPIC_API_KEY, "<redacted>");
      assert.strictEqual(redacted.MODEL, "claude-sonnet-5");
      assert.strictEqual(redacted.password, "<redacted>");
    });
  });

  describe("roleFor", () => {
    it("returns known roles", () => {
      assert(roleFor("kimi").includes("Primary Architect"));
      assert(roleFor("deepseek").includes("Skeptic"));
      assert(roleFor("gpt").includes("Gohok"));
      assert(roleFor("local").includes("sanity checker"));
    });

    it("returns a fallback for unknown profiles", () => {
      assert(roleFor("unknown").includes("Independent expert reviewer"));
    });
  });

  describe("extractClaudeText", () => {
    it("extracts plain string JSON", () => {
      assert.strictEqual(extractClaudeText('"hello"'), "hello");
    });

    it("extracts from result/response/content fields", () => {
      assert.strictEqual(extractClaudeText('{"result":"r"}'), "r");
      assert.strictEqual(extractClaudeText('{"response":"r"}'), "r");
      assert.strictEqual(extractClaudeText('{"content":"r"}'), "r");
    });

    it("extracts from content array", () => {
      assert.strictEqual(extractClaudeText('{"content":[{"text":"a"},{"text":"b"}]}'), "a\nb");
    });

    it("falls back to raw text on invalid JSON", () => {
      assert.strictEqual(extractClaudeText("plain text"), "plain text");
    });
  });

  describe("extractJsonObject", () => {
    it("parses plain JSON", () => {
      assert.deepStrictEqual(extractJsonObject('{"a":1}'), { a: 1 });
    });

    it("parses fenced JSON", () => {
      assert.deepStrictEqual(extractJsonObject("```json\n{\"a\":1}\n```"), { a: 1 });
    });

    it("extracts first object from mixed text", () => {
      assert.deepStrictEqual(extractJsonObject("prefix {\"a\":1} suffix"), { a: 1 });
    });

    it("returns null when no object found", () => {
      assert.strictEqual(extractJsonObject("no object here"), null);
    });
  });

  describe("normalizeAction", () => {
    const validProfiles = ["kimi", "deepseek"];

    it("normalizes a plain text response", () => {
      const action = normalizeAction("hello", "kimi", validProfiles);
      assert.strictEqual(action.public_message, "hello");
      assert.deepStrictEqual(action.direct_messages, []);
      assert.strictEqual(action.ready_to_finalize, false);
    });

    it("keeps scoring card and direct messages", () => {
      const action = normalizeAction({
        public_message: "hi",
        scoring_card: { a: 8 },
        direct_messages: [{ to: "deepseek", type: "challenge", message: "why?", requires_response: true }],
        ready_to_finalize: true,
        confidence: "high",
      }, "kimi", validProfiles);
      assert.strictEqual(action.public_message, "hi");
      assert.deepStrictEqual(action.scoring_card, { a: 8 });
      assert.strictEqual(action.direct_messages.length, 1);
      assert.strictEqual(action.direct_messages[0].to, "deepseek");
      assert.strictEqual(action.ready_to_finalize, true);
    });

    it("filters direct messages to self or unknown profiles", () => {
      const action = normalizeAction({
        public_message: "hi",
        direct_messages: [
          { to: "kimi", message: "self" },
          { to: "unknown", message: "bad" },
          { to: "deepseek", message: "ok" },
        ],
      }, "kimi", validProfiles);
      assert.strictEqual(action.direct_messages.length, 1);
      assert.strictEqual(action.direct_messages[0].to, "deepseek");
    });
  });

  describe("toolArgsForPolicy", () => {
    it("returns empty for allow-tools", () => {
      assert.deepStrictEqual(toolArgsForPolicy({ allowTools: true, allowReadTools: false }), []);
    });

    it("returns Read/Glob/Grep for allow-read-tools", () => {
      assert.deepStrictEqual(toolArgsForPolicy({ allowTools: false, allowReadTools: true }), ["--tools", "Read,Glob,Grep"]);
    });

    it("returns empty tools list by default", () => {
      assert.deepStrictEqual(toolArgsForPolicy({ allowTools: false, allowReadTools: false }), ["--tools", ""]);
    });
  });

  describe("validatePathWithinBase", () => {
    const base = os.tmpdir();

    it("returns resolved path within base", () => {
      const resolved = validatePathWithinBase(path.join(base, "sub"), base, "test");
      assert.strictEqual(resolved, path.join(base, "sub"));
    });

    it("throws when path escapes base via ..", () => {
      assert.throws(() => validatePathWithinBase(path.join(base, "..", "escape"), base, "test"), /test must be within/);
    });

    it("throws for absolute path outside base", () => {
      assert.throws(() => validatePathWithinBase("/etc/passwd", base, "test"), /test must be within/);
    });
  });

  describe("resolveWorkspace", () => {
    it("defaults to cwd", () => {
      assert.strictEqual(resolveWorkspace(), process.cwd());
    });

    it("throws for path outside cwd", () => {
      assert.throws(() => resolveWorkspace("/tmp"), /--workspace must be within/);
    });
  });
});
