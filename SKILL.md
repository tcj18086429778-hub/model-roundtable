---
name: claude-roundtable
description: Run a Codex-moderated multi-model discussion through model/API profiles such as kimi (Kimi K3) and deepseek (DeepSeek V4 Pro). Use when the user requests multi-model debate, when research-driven decision stalemates or conflicting user directives are detected (e.g. repeated user indecision over alternatives), when evaluating complex tradeoffs with Red-Teaming personas, or when producing a best final recommendation after interactive multi-round review. Opus/gohok is temporarily disabled for skill-driven calls.
---

# Claude Roundtable

Use this skill to run a controlled discussion between multiple model/API profiles, then let Codex act as the moderator and final decision maker.

There are two modes:

- `scripts/roundtable.js`: V1 batch mode. Each model answers fixed rounds from a transcript.
- `scripts/interactive-roundtable.js`: V2 interactive mode. Each model gets a persistent meeting session, can send direct messages to other models, and the controller routes replies.

Prefer V2 when the user asks for a discussion group, live debate, direct challenges, or back-and-forth reasoning. Use V1 for faster, cheaper one-pass comparison.

The goal is not free-form chat. The goal is structured multi-model deliberation:

1. Each model gives an independent answer with a structured Scoring Card.
2. Each model critiques the others from its specialized persona perspective.
3. Each model revises its recommendation.
4. Codex synthesizes the final answer, risks, and execution plan.

## Triggers & Activation Scenarios

Activate this skill when:
1. **Explicit Request**: The user asks for multi-model debate, roundtable discussion, or model comparison.
2. **Conflicting Perspectives in Prompt**: The user's prompt presents inherently contradictory constraints or opposing team opinions (e.g. "We are debating between microservices vs monolith...").
3. **Decision Stalemate / Repeated Indecision**: The user has asked about or oscillated between the same technical choices for multiple turns without reaching a clear decision.
4. **High-Risk Research Decisions**: Research-heavy architectural choices requiring deep trade-off evaluation before writing any code.

## Prerequisites

This skill expects local model/API profiles defined in `~/.claude/api-profiles.json`. Each profile tells the skill which model to call and which environment variables (usually an API key) to pass to `claude -p`.

Example `~/.claude/api-profiles.json`:

```json
{
  "kimi": {
    "description": "Kimi K3 Coding Plan",
    "model": "kimi-k3-coding",
    "env": {
      "ANTHROPIC_API_KEY": "sk-ant-..."
    }
  },
  "deepseek": {
    "description": "DeepSeek V4 Pro",
    "model": "deepseek-v4-pro",
    "env": {
      "ANTHROPIC_API_KEY": "sk-ant-..."
    }
  },
  "gpt": {
    "description": "OpenAI GPT builder",
    "model": "gpt-5.4",
    "env": {
      "OPENAI_API_KEY": "sk-..."
    }
  }
}
```

Notes:
- The `model` value must be valid for your local `claude` CLI installation.
- The skill creates temporary per-profile `settings.json` files containing `env`. These files are written with `0o600` permissions and deleted immediately when a child process exits or when the parent process receives `exit`/`SIGINT`/`SIGTERM`.
- Before running a roundtable, confirm the requested profiles exist in `~/.claude/api-profiles.json` if you ask for a non-default profile list.

## Default Participants & Persona Specialization

Use these profiles by default:

```text
kimi,deepseek
```

Profile roles:

| Profile | Role & Persona |
| --- | --- |
| `kimi` | Kimi K3 (Coding Plan) — **Primary Architect & Pragmatic Implementer**. Focus on code architecture, modularity, practical trade-offs, and maintainability. |
| `deepseek` | DeepSeek V4 Pro — **Red-Teamer & Skeptic**. Focus on security edge-cases, system complexity, performance risks, regression hazards, and cost. |
| `gpt` | Gohok `gpt-5.4` builder and product/implementation reasoner. |
| `local` | Optional local-router sanity check or low-cost extra reviewer. |

Temporarily disabled:

| Profile | Rule |
| --- | --- |
| `gohok` / Opus | Do not include in roundtable runs until the user explicitly re-enables Opus. Use `kimi` or `deepseek` for high-capability review. |

## Quick Start

From any trusted workspace:

```bash
node "$HOME/.codex/skills/claude-roundtable/scripts/interactive-roundtable.js" --topic "Should we rewrite the auth module or refactor it incrementally?"
```

On Windows (PowerShell):

```powershell
node "$env:USERPROFILE\.codex\skills\claude-roundtable\scripts\interactive-roundtable.js" --topic "Should we rewrite the auth module or refactor it incrementally?"
```

Common options:

```bash
node "$HOME/.codex/skills/claude-roundtable/scripts/interactive-roundtable.js" --topic "..." --profiles kimi,deepseek --cycles 2
node "$HOME/.codex/skills/claude-roundtable/scripts/interactive-roundtable.js" --topic "..." --allow-read-tools
node "$HOME/.codex/skills/claude-roundtable/scripts/interactive-roundtable.js" --topic-file ./topic.md --profiles kimi,deepseek,gpt
node "$HOME/.codex/skills/claude-roundtable/scripts/interactive-roundtable.js" --topic "..." --dry-run
node "$HOME/.codex/skills/claude-roundtable/scripts/roundtable.js" --topic "..." --profiles kimi,deepseek --rounds 3
```

The script writes a run directory under:

```text
roundtable-runs/<timestamp>/
```

Read `interactive-transcript.md` after V2 finishes, or `roundtable-transcript.md` after V1 finishes. Use it as evidence for Codex's final synthesis.

## Tool Policy

By default, participants are not allowed to use any Claude tools. This prevents accidental file changes during deliberation.

- `--allow-read-tools`: Allow only read-only tools (`Read`, `Glob`, `Grep`) so participants can inspect workspace files.
- `--allow-tools`: Allow the participant's default tool set. Use with caution.

`--allow-tools` and `--allow-read-tools` are mutually exclusive.

## Workflow

### 1. Clarify The Topic & Context Grounding

Before running the script, Codex (as Moderator) MUST ensure all participating models are fully informed about the user's project or idea:

1. **Context Summary**: Include project purpose, key tech stack, constraints, and specific code locations in `--topic` or `--topic-file`.
2. **File References**: Attach design proposals or architecture docs via `--topic-file` when discussing abstract ideas.
3. **Read-Only Code Inspection**: Pass `--allow-read-tools` if participants need to inspect repository files directly to verify assumptions against real implementation.

Make the topic concrete before running the script. Include:
- The decision or research question to resolve.
- Project constraints, stack, or protected behavior.
- Relevant repository paths or files involved.
- What the final answer should optimize for.

### 2. Run The Roundtable Script

Use `scripts/interactive-roundtable.js` for discussion-group behavior. Use `scripts/roundtable.js` for fixed batch review.

Both scripts:

- Read profiles from `~/.claude/api-profiles.json`.
- Create temporary per-profile settings files.
- Call `claude -p` with `--settings <temp-file>`.
- Apply the tool policy (`--allow-read-tools`, `--allow-tools`, or none).
- Do not modify global `~/.claude/settings.json`.
- Save every prompt and response to the run directory.
- Redact token-like values from metadata.

V2 additionally:

- Assigns a unique Claude `--session-id` to each participant.
- Resumes each participant's own session across turns with `--resume`.
- Writes `state.json`, `messages.jsonl`, and `interactive-transcript.md`.
- Routes direct model-to-model messages such as questions, challenges, answers, and support.
- Stops direct-message routing at `--max-directed-turns` to avoid runaway discussions.

### 3. Synthesize As Codex

After the script finishes:

1. Read `roundtable-transcript.md` or `interactive-transcript.md`.
2. Compare claims against known context and files when relevant.
3. Compare model **Scoring Cards** to identify areas of consensus and sharp disagreement.
4. Lead with the best final recommendation.
5. Include important disagreements and why they matter.
6. Surface residual risks and open questions.

Do not blindly vote by majority. Prefer the recommendation with the best evidence, lowest unmanaged risk, and clearest implementation path.

## Output Shape

Return the final answer in this shape unless the user asks otherwise:

```markdown
## Best Recommendation
...

## Why This Wins
...

## Model Positions & Scoring Matrix
- kimi (Architect): ...
- deepseek (Red-Teamer): ...

## Key Disagreements
...

## Risks
...

## Execution Plan
1. ...
2. ...
3. ...

## Open Questions
...
```

## Safety & File Cleanup Rules

- **API Settings Cleanup**: Temporary per-profile API credential files (`settings.json`) are created in system `tmp` directories with `0o600` permissions and are **deleted immediately when the child process exits or when the parent receives `exit`/`SIGINT`/`SIGTERM`**.
- **Run Directory Storage**: Debate artifacts are stored in `roundtable-runs/<timestamp>/` for Codex synthesis and user audit trails. Older run directories can be safely deleted at any time without impacting active sessions.
- **Session Lifespan**: Claude CLI session IDs (`sessionId`) exist only for the duration of a single roundtable run and do not pollute global user memory.
- Never write API keys into prompts, transcripts, final answers, or skill files.
- Do not change `~/.claude/settings.json` to run the roundtable.
- Do not accept a model's claim about local files without checking the files yourself.
- If a model command fails, include the failure in the synthesis instead of hiding it.

## Prompt Templates

Use `references/prompt-patterns.md` when you need to inspect or adjust the participant prompts. The script already embeds the standard prompts, so most runs do not need to load this reference.
