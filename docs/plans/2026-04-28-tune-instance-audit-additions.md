# Tune-Instance Audit Additions Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Each task is self-contained; commit after each.

**Goal:** Add two new audit categories to the `tune-instance` skill (KPR-72) so a future audit pass would have caught the KPR-97 self-echo bug statically:

1. **Engine-superseded prompt instructions** (finding prefix `E`) — find per-agent prompt instructions that the engine already handles automatically, making the instruction stale or actively harmful (double-prefix, double-formatting, double-routing).
2. **Seed-tool-claim vs. constitution-rule mismatch** (finding prefix `R`) — when the constitution prohibits or scopes a behavior, but an agent's prompt or seed YAML advertises the prohibited tool/behavior with no caveat, flag the mismatch.

**Architecture:** `tune-instance` is an agentic skill — a markdown playbook (`skills/tune-instance/SKILL.md`) the Beekeeper agent loads when invoked. The two new categories are codified by:
- adding **two new Phase 1 audit steps** (Step 11 engine-superseded, Step 12 rule-mismatch) with detection guidance and a small **engine-handled-behaviors registry** seeded with at least 3 entries.
- extending the **Phase 2 category-prefix table** with `E` and `R`.
- extending the **Phase 4 verb-vocabulary** so deferred findings in these categories carry stable signatures.
- adding the same categories to **README.md cherry-pick syntax** + the **prefix-key list**.
- updating the **design spec** at `docs/specs/2026-04-26-tune-instance-skill-design.md` so spec → SKILL.md → README parity is preserved.

No TypeScript, no MCP changes — this is playbook + registry codification only. The same Beekeeper agent that already invokes `tune-instance` runs the new detection passes by walking the registry the SKILL.md ships with.

**Spec reference:** `docs/specs/2026-04-26-tune-instance-skill-design.md` (KPR-72, shipped 2026-04-26 via PR #23).

**Bug source the new categories would have caught:** KPR-97 root-cause writeup (filed in Linear). The dodi instance's five agents (jessica, river, sige, milo, jasper) each carried a per-agent prompt instruction `"Always prefix every Slack message with :emoji: **Name**:"` while `~/github/hive/src/channels/slack-adapter.ts:144-145` already auto-prepends `<icon> *<name>*: ` to every outgoing message. Result: visible double-prefix `:emoji: **Name**: :emoji: **Name**: actual reply`. Wyatt's pre-fix seed (`plugins/dodi/agent-seeds/product-specialist.yaml:87` at commit `ec2a293^`) advertised `Slack MCP — search messages, read channels, send messages` with no caveat while the constitution at `templates/constitution-bootstrap.md.tpl:107-121` says `"Never use Slack MCP tools to reply to the message you're currently handling."` Wyatt followed the more concrete instruction in his own seed and called `slack_chat_postMessage` to reply.

**Tech Stack:** Markdown only. No code, no Vitest, no new dependencies. `npm run check` runs typecheck + the existing lint + the existing test suite — adding markdown does not change its behavior, but the gate must still be clean.

---

## File Structure

### Files to modify

| File | Reason |
|---|---|
| `skills/tune-instance/SKILL.md` | Add Phase 1 Step 11 (engine-superseded) + Step 12 (rule-mismatch). Extend the Phase 2 category-prefix table with `E` and `R`. Extend the Phase 4 verb vocabulary to cover the new steps. |
| `skills/tune-instance/README.md` | Update the operator-facing prefix-key list + add the two new categories to the cherry-pick syntax examples. |
| `docs/specs/2026-04-26-tune-instance-skill-design.md` | Add a new "Audit additions (KPR-102)" section under "Design" that documents the two new categories and points back to KPR-97 as the motivating bug. Update Acceptance criteria. |

### Files NOT touched

- No `src/` changes — the skill is markdown.
- No `package.json` — the `skills/` directory already ships in the npm tarball (Task 2 of KPR-72's plan).
- No new tests — the skill is markdown; KPR-72's vitest coverage on `skill-installer.ts` is unaffected.

---

## Engine-handled-behaviors registry shape

The registry lives **inline in SKILL.md** under the new Step 11 section. Markdown table form, easy to read and easy to extend. Each entry is a row:

| Field | Meaning |
|---|---|
| **id** | Stable short slug (`slack-prefix-double`, `slack-mrkdwn-double`, …). Used in finding signatures. |
| **engine behavior (one-line summary)** | What the engine does automatically. |
| **engine source** | File + line range (or function name if lines drift) in `~/github/hive/`. |
| **stale-instruction pattern** | A loose regex / phrase to grep for in the agent's `systemPrompt` field (`agent_definitions.systemPrompt`). |
| **why this is a problem** | One sentence on the visible failure mode. |
| **proposed remediation** | Short verb + payload. Usually `remove-instruction` (the prompt sentence is dropped). |

### Initial registry entries (3 minimum, target 5)

The plan ships these 5 — the operator can add more as new engine-handled cases surface during real-world audit runs.

#### Entry 1 — `slack-prefix-double` (the KPR-97 root cause)

- **Engine behavior:** Auto-prepends `<icon> *<agent-name>*: ` (Slack mrkdwn bold) to every outgoing message.
- **Engine source:** `~/github/hive/src/channels/slack-adapter.ts:144-145` (the `${avatar}*${agentConfig.name}*: ${text}` line in `SlackAdapter.deliver()`).
- **Stale-instruction pattern:** `/(prefix|start).{0,30}(every|all|each).{0,40}(slack|message|reply).{0,80}(:[a-z_]+:|emoji|\*\*[A-Z][a-z]+\*\*)/i` plus a fuzzier check: any sentence containing both "prefix" and an agent name in `**bold**` form within 60 chars.
- **Why it's a problem:** The agent and the engine each prepend the prefix → visible `:emoji: **Name**: :emoji: **Name**: actual reply`.
- **Proposed remediation:** `remove-instruction` — drop the sentence from the prompt. The engine already does the work.

#### Entry 2 — `slack-mrkdwn-bold-double` (markdown-to-mrkdwn auto-conversion)

- **Engine behavior:** Auto-converts standard Markdown (`**bold**`, `__bold__`, `# headers`, `[text](url)`, `~~strike~~`) to Slack mrkdwn (`*bold*`, `*Header*`, `<url|text>`, `~strike~`) via `markdownToMrkdwn()`.
- **Engine source:** `~/github/hive/src/slack/response-formatter.ts:5-22` (the `markdownToMrkdwn` function, called from `formatResponse` line 24-30, called from slack-adapter line 142).
- **Stale-instruction pattern:** Per-agent prompt sentences instructing the agent to "manually" or "always" use Slack mrkdwn syntax (`use *single asterisk* not **double**`, `wrap headers in single asterisks`, `Slack uses *bold* not **bold**`). Loose regex: `/(slack|mrkdwn).{0,40}(use|format|write).{0,40}(\*[^*]|single asterisk|not.*\*\*|<url\|text>)/i`.
- **Why it's a problem:** The agent writes mrkdwn → the engine "converts" the already-mrkdwn output and may produce malformed output (e.g., a single `*` inside a list item gets re-interpreted). At minimum, the prompt sentence wastes context bytes.
- **Proposed remediation:** `remove-instruction` — write standard Markdown; the engine handles the conversion.

#### Entry 3 — `slack-long-message-split` (oversized-message handling)

- **Engine behavior:** Auto-splits messages over Slack's per-message char limit and falls back to file upload for very long content.
- **Engine source:** `~/github/hive/src/slack/slack-gateway.ts:460-526` (`postSplit` + `postAsFile`, called from `postMessage` when length exceeds threshold).
- **Stale-instruction pattern:** Per-agent prompt sentences telling the agent to "keep responses under N characters" *for delivery reasons specifically* (not for clarity reasons). Loose regex: `/(keep|limit|stay under).{0,40}(\d{3,5}|3000|2000|4000).{0,40}(char|character|byte).{0,80}(slack|delivery|message limit)/i`. **Exclude** clarity-driven brevity instructions ("keep responses tight, ~2 paragraphs") — those are about reader experience, not transport.
- **Why it's a problem:** Agents truncate responses they shouldn't, or pre-emptively summarize, when the engine would have handled the long output gracefully (split into chunks or upload as a file).
- **Proposed remediation:** `remove-instruction` — let the engine handle transport-level limits.

#### Entry 4 — `slack-thread-routing` (auto-threading replies)

- **Engine behavior:** Replies to a Slack message automatically thread under the original `thread_ts` (or `ts` if the message was a parent). The agent does not pass `thread_ts` — the channel adapter does.
- **Engine source:** `~/github/hive/src/channels/slack-adapter.ts:130-149` (the `replyThread = isIntegrationMsg ? undefined : threadTs` logic and `postMessage(channel, text, replyThread, identity)` call).
- **Stale-instruction pattern:** Per-agent prompt sentences telling the agent to "thread your reply" or "use thread_ts" or "respond in the same thread" *as if it were the agent's responsibility*. Loose regex: `/(set|use|pass|include).{0,40}(thread_ts|threadTs).{0,80}(reply|respond)/i` plus the looser phrase-search "respond in the thread" within a per-agent prompt section that's about reply mechanics.
- **Why it's a problem:** The agent assumes responsibility for threading and may try to call `slack_chat_postMessage` with `thread_ts` directly — exactly the KPR-97 self-echo bug pattern. The engine already threads correctly when the agent just returns text.
- **Proposed remediation:** `remove-instruction` — return text; the engine handles threading.

#### Entry 5 — `slack-error-formatting` (auto-formatted errors)

- **Engine behavior:** Errors returned by the agent (or thrown during delivery) are auto-wrapped as `Something went wrong: <message>` via `formatError()`.
- **Engine source:** `~/github/hive/src/slack/response-formatter.ts:32-34` (the `formatError` function), called from slack-adapter line 142.
- **Stale-instruction pattern:** Per-agent prompt sentences telling the agent to "wrap errors in" or "format errors as" or "prepend errors with" specific phrases. Loose regex: `/(wrap|format|prefix|prepend).{0,40}(error|failure|problem).{0,40}(with|as|like).{0,80}("|'|`)/i`.
- **Why it's a problem:** Double-wrapping errors (`Something went wrong: Something went wrong: <real error>`) is mostly cosmetic but signals stale prompt content.
- **Proposed remediation:** `remove-instruction` — return the raw error text; the engine wraps it.

> **Two-source-of-truth note.** The registry lives in `SKILL.md` because the SKILL is the unit the Beekeeper agent loads. Engine line numbers drift; the audit step explicitly tells the operator to **re-verify line ranges against `~/github/hive` main before treating a finding as actionable** (function-name reference + lineno hint, same pattern Step 4 uses for `buildAllServerConfigs()`).

---

## Rule-mismatch detection shape

Step 12 has no registry — it derives its rules dynamically from the constitution. The detection is two-pass:

1. **Constitution scan** — pull the rendered constitution (same source as Step 1's audit). Match these patterns:
   - `/(never|don't|do not).{0,40}use\s+([A-Z][\w-]+(?:\s+MCP)?)/i` — captures "never use X" rules.
   - `/(only|just).{0,40}use\s+([A-Z][\w-]+(?:\s+MCP)?).{0,80}(for|to|when)/i` — captures "only use X for Y" rules.
   - Plus the canonical anchor `templates/constitution-bootstrap.md.tpl:107-121` "Message Delivery" section (parsed by header text) — it's the source-of-truth rule for the Slack MCP scope contract and the constitution may inline it verbatim.
2. **Per-agent claim scan** — for each rule extracted in pass 1, scan each agent's `systemPrompt` (and the agent's seed YAML if accessible at `<instance>/plugins/<plugin>/agent-seeds/<agent>.yaml` or `~/github/hive/plugins/dodi/agent-seeds/<agent>.yaml`) for tool advertisements that name the prohibited tool *without the scoping caveat*. The detection is conservative:
   - Find any line in the agent prompt or seed that names the tool (e.g., `Slack MCP`, `slack_send_message`, `chat_postMessage`).
   - Check whether the same paragraph (or the next 2 sentences) restate the constitutional caveat (`"never to reply"`, `"outbound only"`, `"do not use to reply to the conversation you're currently handling"`).
   - If the tool is named without the caveat → finding `R<N>`.

**Difference from Step 3 (existing tool/claim audit):** Step 3 checks *prompt vs. coreServers* (does the agent claim a tool it doesn't have?). Step 12 checks *prompt vs. constitution* (does the agent advertise a tool in a way that violates a constitutional rule?). Different direction, different finding population.

**Frame-aware:** Records with `replacedClaimFrom: <frame-id>` are skipped — the frame is the authoritative claim, not drift.

**Concrete KPR-97 trace:** the constitution rule "Never use Slack MCP tools (`slack_send_message`, `chat_postMessage`, `chat_update`, etc.) to reply to the message you're currently handling" matches pattern 1. Wyatt's pre-fix seed line `Slack MCP — search messages, read channels, send messages` names `Slack MCP` without the caveat — finding `R1`.

---

## Cherry-pick gate integration (existing pattern)

Both new categories surface findings exactly the same way Steps 1–10 do — operator sees `E1`, `E2`, `R1` in the Phase 2 report, picks which to apply via `apply E1, E2; defer R1`, and Phase 3 writes through `admin_save_agent` with `updatedBy: "beekeeper-tune-instance:<runId>"`. No new write paths, no new MCP tools.

---

## Task 1: Add Step 11 (engine-superseded) to SKILL.md Phase 1

**Files:**
- Modify: `skills/tune-instance/SKILL.md`

- [ ] **Step 1.1:** In `skills/tune-instance/SKILL.md`, locate the Phase 1 section. The current last numbered audit step is **Step 10 — Frame integrity** (the section heading `### 10. Frame integrity (post-KPR-83)`). Append a new section **after Step 10** but **before** the `## Frame-awareness` heading:

```markdown
### 11. Engine-superseded prompt instructions

For each agent in `db.agent_definitions.find({})`, scan the `systemPrompt` field against the **engine-handled-behaviors registry** below. A match means the agent's prompt instructs it to do something the Hive engine already handles automatically — the instruction is at best stale (wasted context bytes) and at worst actively harmful (double-prefix, double-formatting, double-routing).

**Why this is different from Step 3 DRY pass:** Step 3 finds *identical* phrases across agents and proposes a constitution candidate. Step 11 finds phrases that contradict engine reality, regardless of how many agents have them. A single agent with a stale instruction is still a finding here; not a finding for Step 3.

**Detection process:**

1. For each agent, extract the `systemPrompt` text.
2. For each registry entry below, run the `stale-instruction pattern` against the prompt.
3. Match → file finding under prefix `E`. Surface the matched sentence verbatim, the registry entry's `engine source` citation, and the proposed remediation.
4. Re-verify the registry entry's `engine source` line range against `~/github/hive` main before treating the finding as actionable. Line numbers drift; function names + the canonical surrounding code stay stable.

**Frame-awareness:** Records with `replacedClaimFrom: <frame-id>` are skipped — the frame is the authoritative claim, not drift.

#### Engine-handled-behaviors registry

| id | engine behavior | engine source | stale-instruction pattern (loose regex / phrase) | proposed remediation |
|---|---|---|---|---|
| `slack-prefix-double` | Auto-prepends `<icon> *<agent-name>*: ` to every outgoing Slack message. | `~/github/hive/src/channels/slack-adapter.ts:144-145` (`SlackAdapter.deliver()`) | `(prefix\|start).{0,30}(every\|all\|each).{0,40}(slack\|message\|reply).{0,80}(:[a-z_]+:\|emoji\|\*\*[A-Z][a-z]+\*\*)` | `remove-instruction` — the engine already does it. |
| `slack-mrkdwn-bold-double` | Auto-converts Markdown (`**bold**`, headers, `[text](url)`, `~~strike~~`) to Slack mrkdwn. | `~/github/hive/src/slack/response-formatter.ts:5-22` (`markdownToMrkdwn`) | `(slack\|mrkdwn).{0,40}(use\|format\|write).{0,40}(\*[^*]\|single asterisk\|not.*\*\*\|<url\|text>)` | `remove-instruction` — write standard Markdown. |
| `slack-long-message-split` | Auto-splits over-limit messages and falls back to file upload. | `~/github/hive/src/slack/slack-gateway.ts:460-526` (`postSplit` + `postAsFile`) | `(keep\|limit\|stay under).{0,40}(\d{3,5}\|3000\|2000\|4000).{0,40}(char\|character\|byte).{0,80}(slack\|delivery\|message limit)` | `remove-instruction` — the engine handles transport limits. Excludes clarity-driven brevity instructions. |
| `slack-thread-routing` | Replies auto-thread under the original `thread_ts` — the channel adapter sets it, not the agent. | `~/github/hive/src/channels/slack-adapter.ts:130-149` (the `replyThread` logic) | `(set\|use\|pass\|include).{0,40}(thread_ts\|threadTs).{0,80}(reply\|respond)` | `remove-instruction` — return text; the engine threads. |
| `slack-error-formatting` | Errors are auto-wrapped via `formatError`. | `~/github/hive/src/slack/response-formatter.ts:32-34` (`formatError`) | `(wrap\|format\|prefix\|prepend).{0,40}(error\|failure\|problem).{0,40}(with\|as\|like).{0,80}("\|'\|`)` | `remove-instruction` — return the raw error; the engine wraps it. |

> The registry is operator-extensible: when an audit run surfaces a new engine-handled behavior, append a row. Each row needs `id`, `engine behavior`, `engine source` (file:line OR function name), `stale-instruction pattern`, and `proposed remediation`.

**Common findings (seeded from KPR-97 root-cause):** five dodi agents (jessica, river, sige, milo, jasper) carried `"Always prefix every Slack message with :emoji: **Name**:"` — every one matches the `slack-prefix-double` pattern. Re-running this audit step against the pre-2026-04-27 dodi state would catch all five.
```

- [ ] **Step 1.2:** Verify

```bash
grep -c "### 11. Engine-superseded" skills/tune-instance/SKILL.md
grep -c "slack-prefix-double\|slack-mrkdwn-bold-double\|slack-long-message-split\|slack-thread-routing\|slack-error-formatting" skills/tune-instance/SKILL.md
```

Expected: heading count = 1; registry-id count >= 5.

- [ ] **Step 1.3:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): KPR-102 — Phase 1 Step 11 engine-superseded prompt audit"
```

---

## Task 2: Add Step 12 (rule-mismatch) to SKILL.md Phase 1

**Files:**
- Modify: `skills/tune-instance/SKILL.md`

- [ ] **Step 2.1:** Append a new section **immediately after Step 11** (still inside the Phase 1 region, still before the `## Frame-awareness` heading):

```markdown
### 12. Seed-tool-claim vs. constitution-rule mismatch

The constitution carries declarative rules (Step 1 already parses it for drift). For each rule with a "never use X" or "only use X for Y" or "scoped to Z only" pattern, scan agent prompts and seed YAMLs for tool advertisements that name X without the scoping caveat.

**Why this is different from Step 3 (tool/claim audit):** Step 3 checks *prompt vs. coreServers* (does the agent claim a tool it doesn't have?). Step 12 checks *prompt vs. constitution* (does the agent advertise a tool in a way that violates a constitutional rule?). Different direction, different finding population.

**Detection process:**

1. **Constitution scan.** Pull the rendered constitution (same source as Step 1). Extract rules matching:
   - `(never|don't|do not).{0,40}use\s+([A-Z][\w-]+(?:\s+MCP)?)` — captures "never use X" rules.
   - `(only|just).{0,40}use\s+([A-Z][\w-]+(?:\s+MCP)?).{0,80}(for|to|when)` — captures "only use X for Y" rules.
   - Plus the canonical "Message Delivery" section anchor (`templates/constitution-bootstrap.md.tpl:107-121` in the engine repo) — parsed by header text, not line range.
2. **Per-agent claim scan.** For each rule extracted, scan each agent's `systemPrompt` AND the agent's seed YAML if accessible (typically at `<instance>/plugins/<plugin>/agent-seeds/<agent>.yaml` or in the engine repo at `~/github/hive/plugins/<plugin>/agent-seeds/`):
   - Find any line that names the prohibited tool (e.g., `Slack MCP`, `slack_send_message`, `chat_postMessage`).
   - Check whether the same paragraph (or the next 2 sentences) restate the constitutional caveat (`"never to reply"`, `"outbound only"`, `"do not use to reply to the conversation you're currently handling"`).
   - If the tool is named without the caveat → finding under prefix `R`. Surface the matched line verbatim, the constitution rule it violates, and the two-path remediation: (a) `rewrite` the prompt/seed to include the caveat, OR (b) `remove-tool` if the agent doesn't actually need the tool.

**Frame-awareness:** Records with `replacedClaimFrom: <frame-id>` are skipped — the frame is the authoritative claim, not drift.

**Conservative matching note:** the patterns are deliberately loose to catch more drift, but that means false positives are possible. Each finding ships the matched sentence + the constitution rule + the proposed remediation; the operator decides at the cherry-pick gate. False-positive rate is acceptable because the cherry-pick gate is the safety net, not the regex.

**Concrete KPR-97 trace:** the constitution rule `"Never use Slack MCP tools (slack_send_message, chat_postMessage, chat_update, etc.) to reply to the message you're currently handling"` matches pattern 1 (`(never).{0,40}use\s+(Slack MCP)`). Wyatt's pre-fix seed line `Slack MCP — search messages, read channels, send messages` (at `plugins/dodi/agent-seeds/product-specialist.yaml:87` in the engine repo, commit `ec2a293^`) names `Slack MCP` and `send messages` without the caveat → finding `R1` proposed remediation `rewrite` (add the caveat) OR `remove-tool` (remove `slack_send_message` from the seed if the agent doesn't post cross-channel).
```

- [ ] **Step 2.2:** Verify

```bash
grep -c "### 12. Seed-tool-claim" skills/tune-instance/SKILL.md
grep -c "prefix \`R\`\|finding under prefix R\|finding \`R" skills/tune-instance/SKILL.md
```

Expected: heading count = 1; R-prefix references >= 1.

- [ ] **Step 2.3:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): KPR-102 — Phase 1 Step 12 rule-mismatch audit"
```

---

## Task 3: Extend Phase 2 category-prefix table + Phase 4 verb vocabulary

**Files:**
- Modify: `skills/tune-instance/SKILL.md`

- [ ] **Step 3.1:** In the `## Phase 2 — Operator review` section, locate the per-category prefixes list. Currently:

```
- `C` = constitution drift
- `B` = business-context separation
- `P` = per-agent prompts
- `T` = coreServers baseline (tool matrix)
- `M` = memory hygiene
- `K` = cron→skill wiring
- `S` = skill availability
- `N` = naming-identity
- `F` = frame integrity
```

Append two more lines at the end of that bullet list:

```
- `E` = engine-superseded prompt instructions
- `R` = seed-tool-claim vs. constitution-rule mismatch
```

- [ ] **Step 3.2:** In the example report shape (the fenced-text block under `Example report shape:`), the current placeholder text mentions only `[plus business-context (B), coreServers baseline (T), cron→skill (K), skill availability (S), naming/identity (N)]` and `FRAME INTEGRITY (0 findings)`. Update the placeholder line to include the two new categories so the operator-facing example matches the prefix list. Replace:

```
[plus business-context (B), coreServers baseline (T), cron→skill (K), skill availability (S), naming/identity (N)]

FRAME INTEGRITY (0 findings)  [or N if frames applied]
```

with:

```
[plus business-context (B), coreServers baseline (T), cron→skill (K), skill availability (S), naming/identity (N)]

FRAME INTEGRITY (0 findings)  [or N if frames applied]

ENGINE-SUPERSEDED (E findings)
  E1. jasper: "Always prefix every Slack message..." — engine already prepends (slack-prefix-double) — propose: remove instruction
  ...

RULE-MISMATCH (R findings)
  R1. wyatt seed: "Slack MCP — send messages" w/o no-self-reply caveat (constitution Message Delivery) — propose: rewrite OR remove-tool
  ...
```

This makes the report-shape section a faithful demo of how the new categories appear.

- [ ] **Step 3.3:** In the `## Phase 4 — Save findings` section, locate the **Verb vocabulary** subsection. Currently it lists verbs by audit step 1–10. Add two new lines immediately after the Step 10 line:

```
- Step 11 (engine-superseded): `remove-instruction`, `rewrite`
- Step 12 (rule-mismatch): `rewrite`, `remove-tool`, `add-caveat`
```

Rationale on verb choices:
- `remove-instruction` (Step 11) — the dominant action: drop the stale prompt sentence.
- `rewrite` (Step 11) — fallback when the operator wants to keep the sentence but reword it (rare, but the verb space should not box them in).
- `rewrite` (Step 12) — add the missing caveat to the prompt/seed text.
- `remove-tool` (Step 12) — remove the tool from `coreServers` / `delegateServers` if the agent doesn't actually need it (the cleaner fix when the advertisement was aspirational).
- `add-caveat` (Step 12) — surgical mode: append the caveat sentence without rewriting the surrounding paragraph. Distinct from `rewrite` because the signature payload carries the caveat text verbatim, and the next-run signature lookup matches on caveat presence not on the surrounding prose.

- [ ] **Step 3.4:** In the `## Phase 4 — Save findings` example JSON block (the fenced ` ```json ` block at the end of the section), the existing `findings[]` array shows two example entries (a `C1` constitution finding and a `P1` per-agent-prompt finding). Append a third example entry showing an Step 11 finding so the JSON shape is concrete:

```json
    ,
    {
      "id": "E1",
      "category": "engine-superseded",
      "step": "step-11-engine-superseded",
      "target": "jasper",
      "proposedAction": { "verb": "remove-instruction", "payload": { "registryEntry": "slack-prefix-double" } },
      "signature": "9d2e7c5f3a1b",
      "disposition": "applied"
    }
```

- [ ] **Step 3.5:** Verify

```bash
grep -c "\`E\` = engine-superseded\|\`R\` = seed-tool-claim" skills/tune-instance/SKILL.md
grep -c "Step 11 (engine-superseded)\|Step 12 (rule-mismatch)" skills/tune-instance/SKILL.md
grep -c "remove-instruction\|add-caveat" skills/tune-instance/SKILL.md
```

Expected: prefix-list count = 2 (one each); verb-vocabulary count = 2; verb count >= 2.

- [ ] **Step 3.6:** Commit

```bash
git add skills/tune-instance/SKILL.md
git commit -m "feat(skill): KPR-102 — extend Phase 2 prefix table + Phase 4 verb vocabulary"
```

---

## Task 4: Update README.md prefix list and cherry-pick examples

**Files:**
- Modify: `skills/tune-instance/README.md`

- [ ] **Step 4.1:** In `skills/tune-instance/README.md`, locate the "Phase 2 — Operator review" paragraph in the "What each phase does" section. The current text mentions `category prefixes (C/B/P/T/M/K/S/N/F)`. Update it to `category prefixes (C/B/P/T/M/K/S/N/F/E/R)`.

- [ ] **Step 4.2:** Locate the "Cherry-pick syntax" section. Add one new example illustrating the new categories. After the existing `apply P2 with trim-role; defer P1` example bullet, append:

```
- `apply E1, E2; defer R1` — engine-superseded fixes are usually safe (the engine already handles the behavior); rule-mismatch may want operator review of the rewrite vs. remove-tool choice.
```

- [ ] **Step 4.3:** Add a new short subsection at the end of the README, before the "Cadence" section, titled `## Audit categories at a glance`:

```markdown
## Audit categories at a glance

| Prefix | Category | Walkthrough |
|---|---|---|
| `C` | Constitution drift | redundancy, template-drift backfills, sections that duplicate business-context |
| `B` | Business-context separation | org/escalation content that belongs in constitution; team-directory accuracy |
| `P` | Per-agent prompts | length, DRY, voice, approval-delegation, cron-pointer, model ceiling |
| `T` | coreServers baseline | universal-9 gaps |
| `M` | Memory hygiene | hot/warm/cold tier sanity, duplicates, conversational meta-text |
| `K` | Cron → skill wiring | scheduled tasks resolve to a real skill |
| `S` | Skill availability | per-instance skills/ overrides, post-0.2.0 migration recovery |
| `N` | Naming/identity | agent-dir convention, Slack channel naming, email-address conventions |
| `F` | Frame integrity | post-KPR-83; `applied.json` ↔ live config consistency |
| `E` | Engine-superseded prompt instructions | per-agent prompt sentences telling the agent to do what the engine already does (added KPR-102, motivated by KPR-97) |
| `R` | Rule-mismatch | tool advertisements in prompt/seed that violate a constitution `never use X` / `only use X for Y` rule (added KPR-102, motivated by KPR-97) |

If you encounter a new engine-handled behavior the audit didn't catch, append a row to the Step 11 registry in `SKILL.md`. The registry is operator-extensible by design.
```

- [ ] **Step 4.4:** Verify

```bash
grep -c "C/B/P/T/M/K/S/N/F/E/R" skills/tune-instance/README.md
grep -c "Audit categories at a glance" skills/tune-instance/README.md
grep -c "apply E1, E2" skills/tune-instance/README.md
```

Expected: prefix-list count = 1; section heading = 1; cherry-pick example count = 1.

- [ ] **Step 4.5:** Commit

```bash
git add skills/tune-instance/README.md
git commit -m "docs(skill): KPR-102 — README prefix list + cherry-pick + categories table"
```

---

## Task 5: Update spec with new audit categories

**Files:**
- Modify: `docs/specs/2026-04-26-tune-instance-skill-design.md`

- [ ] **Step 5.1:** In `docs/specs/2026-04-26-tune-instance-skill-design.md`, locate the `### Phase 1 — Audit (read-only)` section. After the existing 9-item list (steps 1 through 9), add two new list items 10 — wait, the spec already has Step 10 (frame integrity) implicit in the frame-awareness section. Add two new entries 11 and 12:

```markdown
11. **Engine-superseded prompt instructions** (added KPR-102) — per-agent prompt instructions that the engine already handles automatically. Detection scans `agent_definitions.systemPrompt` against an in-skill registry of engine-handled behaviors (initial seed: 5 entries covering Slack prefix auto-prepending, markdown→mrkdwn auto-conversion, oversized-message auto-split, auto-threading, error-message auto-wrapping). Findings surface under prefix `E`. Frame-aware (records with `replacedClaimFrom` skipped).
12. **Seed-tool-claim vs. constitution-rule mismatch** (added KPR-102) — when the constitution carries `"never use X"` or `"only use X for Y"` rules, scan agent prompts and seed YAMLs for tool advertisements that name X without the scoping caveat. Findings surface under prefix `R`. Frame-aware. KPR-97 root cause example: Wyatt's seed advertised `Slack MCP — send messages` while the constitution says `"Never use Slack MCP tools to reply to the message you're currently handling"`.
```

- [ ] **Step 5.2:** Locate the Phase 2 prefix table in spec §"Acceptance criteria" line containing `C/B/P/T/M/K/S/N/F`. Update to `C/B/P/T/M/K/S/N/F/E/R`. There are two occurrences in the spec — both need the same update.

- [ ] **Step 5.3:** Locate the Phase 4 verb-vocabulary block in spec §"Phase 4 — Save findings". After the Step 10 line:

```
- Step 10 (frame integrity, post-KPR-83): `reapply-frame`, `remove-frame`
```

Append:

```
- Step 11 (engine-superseded, post-KPR-102): `remove-instruction`, `rewrite`
- Step 12 (rule-mismatch, post-KPR-102): `rewrite`, `remove-tool`, `add-caveat`
```

- [ ] **Step 5.4:** Add a new acceptance criterion to spec §"Acceptance criteria" (the existing 16-item bulleted list). Insert two new bullets after the existing "Anti-patterns enforced" bullet (the last one):

```markdown
- [ ] Phase 1 Step 11 (engine-superseded) ships with at least 3 registry entries seeded; registry is operator-extensible (markdown table format)
- [ ] Phase 1 Step 12 (rule-mismatch) detects constitution `"never use X"` / `"only use X for Y"` patterns and cross-references against agent prompts AND seed YAMLs; records with `replacedClaimFrom` are frame-aware skipped
- [ ] Both new categories surface findings via the existing cherry-pick gate (prefix `E`/`R`); both feed the existing Phase 4 signature contract via the verb-vocabulary additions
- [ ] Re-running the audit against pre-2026-04-27 dodi state would catch KPR-97 (regression: the slack-prefix-double registry entry matches all five affected agents; the rule-mismatch detector matches Wyatt's pre-fix seed)
```

- [ ] **Step 5.5:** Add a short coordination note to spec §"Coordination with sibling tickets":

```markdown
- **KPR-97** (Slack-MCP self-echo bug — root cause analysis) — motivating bug. KPR-102 codifies the two audit categories that would have caught it statically.
```

- [ ] **Step 5.6:** Verify

```bash
grep -c "C/B/P/T/M/K/S/N/F/E/R" docs/specs/2026-04-26-tune-instance-skill-design.md
grep -c "Engine-superseded prompt instructions\|Seed-tool-claim vs. constitution-rule mismatch" docs/specs/2026-04-26-tune-instance-skill-design.md
grep -c "remove-instruction\|add-caveat" docs/specs/2026-04-26-tune-instance-skill-design.md
grep -c "KPR-97" docs/specs/2026-04-26-tune-instance-skill-design.md
```

Expected: prefix-list count >= 2; new-step heading count >= 2; verb count >= 2; KPR-97 reference count = 1.

- [ ] **Step 5.7:** Commit

```bash
git add docs/specs/2026-04-26-tune-instance-skill-design.md
git commit -m "docs(spec): KPR-102 — document tune-instance audit additions in design spec"
```

---

## Task 6: Regression check — would re-run against pre-2026-04-27 dodi catch KPR-97?

**Files:** none — this task is a manual desk-check, output is a one-paragraph note appended to the run's findings doc OR PR description.

The acceptance criterion is: "Both categories surface findings on dodi when re-run against the pre-2026-04-27 state." Since we cannot actually rewind the dodi DB to that state in a test environment, the regression check is:

- [ ] **Step 6.1:** Walk the `slack-prefix-double` registry pattern against the dodi pre-fix state captured in `~/github/hive/plugins/dodi/agent-seeds/*.yaml` at commit `ec2a293^` (just before the KPR-97 fix). Specifically, the affected agents per the ticket were jessica, river, sige, milo, jasper. The prefix instruction was injected into the live runtime (DB-stored agent prompts), not into the seed files — confirm by looking at commit `ec2a293`'s message: "Live runtime was patched on dodi 2026-04-27 via direct DB writes to five agents' system prompts."

- [ ] **Step 6.2:** Manually trace the registry's regex against a representative pre-fix prompt fragment: `"Always prefix every Slack message with :emoji: **Name**: — channel posts, DMs, thread replies."` against `(prefix|start).{0,30}(every|all|each).{0,40}(slack|message|reply).{0,80}(:[a-z_]+:|emoji|\*\*[A-Z][a-z]+\*\*)`:
   - `prefix` matches at position 7.
   - `every` matches within 30 chars.
   - `Slack message` matches within 40 chars.
   - `:emoji:` and `**Name**` both match within 80 chars.
   - Pattern matches → finding `E<n>` would have been raised. Five agents → `E1` through `E5`.

- [ ] **Step 6.3:** Manually trace the rule-mismatch detector against pre-fix Wyatt:
   - Constitution rule extracted from `templates/constitution-bootstrap.md.tpl:107-121`: `"Never use Slack MCP tools (slack_send_message, chat_postMessage, chat_update, etc.) to reply to the message you're currently handling."` — pattern `(never).{0,40}use\s+(Slack MCP)` matches.
   - Wyatt's pre-fix seed at `plugins/dodi/agent-seeds/product-specialist.yaml:87` (commit `ec2a293^`): `"Slack MCP — search messages, read channels, send messages"` — names `Slack MCP` and `send messages`; the surrounding text does not restate the no-self-reply caveat.
   - Mismatch detected → finding `R1` would have been raised.

- [ ] **Step 6.4:** Document the regression check in the PR description. One paragraph: "Manual regression trace against the KPR-97 root-cause confirms both new categories would have caught the bug. The `slack-prefix-double` registry pattern matches the prefix instruction in five dodi agent prompts (jessica, river, sige, milo, jasper). The rule-mismatch detector matches Wyatt's pre-fix seed advertisement of `Slack MCP — send messages` against the constitution's `"Never use Slack MCP tools to reply"` rule."

- [ ] **Step 6.5:** No commit — desk-check, output goes in the PR.

---

## Task 7: Quality gate

- [ ] **Step 7.1:** Run `npm run check`. Expected: clean.

- [ ] **Step 7.2:** Verify no FILLED-IN markers introduced in either file:

```bash
grep -c "FILLED IN BY TASK\|TODO\|FIXME" skills/tune-instance/SKILL.md skills/tune-instance/README.md docs/specs/2026-04-26-tune-instance-skill-design.md
```

Expected: 0 across all three files.

- [ ] **Step 7.3:** Eye-grep the SKILL.md for prefix-table consistency: every prefix in the Phase 2 list (`C/B/P/T/M/K/S/N/F/E/R`) should be the same set as the prefixes that appear as finding-IDs in any example report block. Run:

```bash
grep -oE '^\s*[A-Z][0-9]+\.' skills/tune-instance/SKILL.md | sort -u
```

Expected: every letter in `C/B/P/T/M/K/S/N/F/E/R` shows up at least once (or none at all if the example report block doesn't enumerate them — that's fine; the bullet list is the spec).

---

## Acceptance criteria mapping

| Spec AC (KPR-102 ticket) | Task(s) |
|---|---|
| New audit category "instructions superseded by engine behavior" with at least 3 registry entries | Task 1 (5 entries seeded) |
| New audit category "seed-tool-claim vs. constitution-rule mismatch" implemented | Task 2 |
| Both categories surface findings on dodi when re-run against pre-2026-04-27 state (regression: KPR-97) | Task 6 (manual desk-check; trace recorded in PR) |
| Spec at `docs/specs/2026-04-26-tune-instance-skill-design.md` updated to document the two new categories | Task 5 |

---

## Plan-stage notes

**Why no code changes:** `tune-instance` is an agentic skill — the playbook IS the implementation. The Beekeeper agent reads SKILL.md and executes the steps via existing MCP tools. New audit categories = new SKILL.md sections + registry data + cherry-pick gate awareness. No TypeScript surface.

**Why a 5-entry registry instead of 3:** the ticket asks for 3-5; landing 5 gives the audit immediate breadth in the Slack-engine surface (the area KPR-97 surfaced) without requiring follow-up tickets to expand the registry. Each entry is independently verifiable against `~/github/hive` source. The pattern is documented for the operator to add more.

**Frame-awareness:** both new steps inherit the existing frame-awareness clause (records with `replacedClaimFrom` are skipped). Frame-naive instances behave identically to the pre-KPR-102 baseline.

**Idempotency:** both new audit steps are **structural** (drift that's deterministic given current DB state) — fixing it makes the next audit not re-find it. No content-class entries. Spec §"Idempotency" classifications table updates Task 5 covers via the new step entries.
