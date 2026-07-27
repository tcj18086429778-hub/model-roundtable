# Claude Roundtable Prompt Patterns

Use these patterns when adjusting `scripts/roundtable.js` or manually running a roundtable.

## Default Participants & Persona Specialization

- **kimi** (Kimi K3 / Kimi Coding Plan): *Primary Architect & Pragmatic Implementer*. Focuses on code design, modularity, clean architecture, and rapid implementation.
- **deepseek** (DeepSeek V4 Pro): *Red-Teamer & Skeptic*. Focuses on security risks, edge cases, regression hazards, performance issues, and cost/complexity.

## Independent Proposal

Ask each model to reason independently:

```text
You are one participant in a multi-model engineering roundtable.

Topic:
<topic>

Your role:
<role>

Do not assume the other participants agree with you. Provide:
1. Recommendation
2. Reasoning
3. Scoring Card (1-10 scores for Extensibility, Safety/Low-Risk, Ease of Implementation, Testability)
4. Risks
5. What would change your mind
```

## Cross Critique

Ask each model to review the other answers:

```text
Review the other participants' proposals.

Focus on:
1. Strongest points
2. Weakest assumptions & hidden flaws
3. Missing risks
4. What the final recommendation should preserve or reject
```

## Final Revision

Ask each model to revise:

```text
Based on all proposals and critiques, give your final position.

Include:
1. Final recommendation
2. Why this is better than alternatives
3. Final Scoring Card
4. Remaining risks
5. Execution steps
```

## Codex Synthesis

Codex should not outsource the final decision. Use the transcript as input and decide:

- Which recommendation best fits the constraints.
- Compare the Scoring Cards between models to identify consensus vs disagreements.
- Which objections are real blockers.
- Which risks need mitigation.
- What the user should do next.

## V2 Interactive Message

V2 participants return JSON with a structured scoring card so the controller can route messages:

```json
{
  "public_message": "Visible meeting statement with code grounding references.",
  "scoring_card": {
    "architecture_extensibility": 8,
    "low_breaking_risk": 7,
    "implementation_ease": 8,
    "testability": 9
  },
  "direct_messages": [
    {
      "to": "deepseek",
      "type": "challenge",
      "message": "Your migration plan needs a rollback path. What is it?",
      "requires_response": true
    }
  ],
  "ready_to_finalize": false,
  "confidence": "medium"
}
```

Use direct messages when a participant needs a specific answer from another model. Keep final synthesis in Codex; do not ask a participant to be the judge.

