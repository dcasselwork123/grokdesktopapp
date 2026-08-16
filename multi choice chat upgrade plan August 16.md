# Multi-choice chat upgrade plan

**Date:** 16 August 2026  
**App:** Grok Desktop  
**Goal:** When Grok asks a question mid-task, show real choices in the chat and let you tap an answer — the same Q&A surface Grok Build has in the terminal.

This is feature **#2** from the Grok Build gap audit: *“When Grok asks you a question, let you answer.”*

---

## Why this matters

Grok Build can stop and ask things like:

- Minimal vs bold vs developer-focused?
- Which folder / framework / schema?
- “Other” + a typed answer

In the TUI that is `ask_user_question`: numbered options, arrow keys, Enter.

In Desktop today the turn either:

1. **Guesses** (Full access / `bypassPermissions` — Grok picks and keeps going), or  
2. **Stalls / cancels** (Safer / `dontAsk`), or  
3. Shows a tiny **tool chip** with no way to reply.

For vibe coding this is the difference between “Grok steamrolls my taste” and “Grok checks with me, then builds.”

---

## What Grok Build already defines

Tool: **`ask_user_question`**

```text
questions[]
  question          full question text
  options[]
    label           short button text
    description     what picking it means
    preview         optional extra (mockup, snippet) — single-select only
  multi_select      optional; default false
```

Every question automatically includes an **Other** choice where the user can type a custom answer. Recommended option should be first and labeled “(Recommended)”.

Grok can ask **several questions in one pause**. The TUI shows `1/3`, `2/3`, etc.

Images / previews on an option are optional and can wait for a later pass.

---

## Why this is harder than `/` or generated images

Desktop runs **`grok -p`** (one-shot headless). Stdin is ignored. The HTTP/SSE pipe is **server → UI only** for that turn.

The TUI can answer *inside* the same turn. Headless `-p` cannot receive a button click unless we add a back-channel.

So there are two honest designs:

| Approach | How it works | Pros | Cons |
|---|---|---|---|
| **A. Answer as the next turn** | Detect the question, show cards, user picks, we send a follow-up prompt with the answers | Fits today’s `grok -p` + SSE | Grok may have already auto-picked or exited before you click |
| **B. Mid-turn ACP** | Switch the live turn to `grok agent stdio` (JSON-RPC) so we can return a tool result | Real TUI-like pause | Bigger rewrite of `runPrompt` / `httpApi` |

**Recommendation:** ship **A** first so the UI exists and vibe-coding questions are answerable. Keep **B** as the follow-up if `-p` swallows questions before the cards appear.

---

## Target UX

1. Grok decides it needs a decision and calls `ask_user_question`.
2. The chat shows a **question card** under that turn (not a tool chip):
   - Question text
   - One button per option (label + one-line description)
   - **Other…** expands a short text field
   - If `multi_select`, checkboxes + **Done**
   - If several questions, a stepper: `1 of 3` with Next
3. Composer stays usable but the card is the obvious place to click.
4. After submit:
   - Card switches to a compact “You chose: …” summary (not editable).
   - Desktop sends the answers into the same session.
5. Phone: same card, big tap targets, no hover-only UI.
6. Reopening an old session shows the question + the recorded answer, not an empty chip.

Do **not** auto-send the first option. Do **not** hide the card behind “Grok ran a command.”

---

## Architecture (phase 1)

```
grok -p streaming-json
  → tool_call / tool_call_update  name=ask_user_question
  → server forwards SSE "grok" events (already does)
  → renderer draws QuestionCard
  → user picks
  → POST /api/chat  (same session, not a new one)
       prompt = structured answer block
```

### Detect the question

Parse the same event shapes we already use for tools:

- `evt.toolName` / `evt.name` / `_meta["x.ai/tool"].name` === `ask_user_question`
- `rawInput.questions` or `input.questions` (the schema above)
- `toolCallId` to correlate answer with the ask

Add a small helper (same spirit as `server/sessionMedia.js`):

- `server/sessionQuestions.js` — `extractAskUserQuestions(evt)` → `{ id, questions[] }` or null  
- Unit tests with a canned tool event

Also persist on the tool entry when loading `updates.jsonl`, so history can re-render the card as answered.

### How the answer is sent (phase 1)

After the user submits:

```text
<user_answers>
Question: Minimal or bold?
Answer: Bold & expressive
Question: Framework?
Answer: Other: SvelteKit
</user_answers>
```

Rules:

- Same `sessionId`, **not** `newSession`
- Goes through the existing queue if a turn is still running
- If the asking turn is still marked running and Grok looks stuck (no text after the question), **Stop** that turn, then send the answers (same pattern as today’s interrupt-and-send)
- Log nothing sensitive beyond the labels

### What we will learn in phase 1

Try three real prompts (“design a landing page”, “pick a stack”, “plan this refactor”) and write down:

1. Does `-p` + Full access emit `ask_user_question` at all?  
2. Does the process **exit** after the tool, or **hang**?  
3. Is the question in `rawInput` or only in later `tool_call_update`?

That spike (half a day) decides whether phase 2 is required immediately.

---

## Architecture (phase 2, only if needed)

If `-p` never pauses, or auto-answers before the UI can show:

1. Keep using `-p` for normal turns.  
2. When we see `ask_user_question` **start** (pending), do **not** let the child finish blindly:
   - Either keep the process alive and switch that session to **ACP** (`grok agent stdio`) for the rest of the turn, or  
   - Kill `-p` at the question boundary and resume with `--resume` + the answers (phase 1, but forced).
3. ACP is the real mid-turn channel (`session/update` + a follow-up `session/prompt` or tool result). It is a larger change to `server/grokService.js` (`runPrompt`, stdio, event mapping). Do not start ACP as a full rewrite of chat — only as the transport for “this turn asked a question.”

Phase 2 should be its own PR after the card UI is already shipping on recorded/history events.

---

## UI details

**Files**

| File | Change |
|---|---|
| `renderer/index.html` | No new chrome required; cards are created in JS |
| `renderer/app.js` | Detect question events; `renderQuestionCard`; submit handler |
| `renderer/styles.css` | `.question-card` matching composer / tool-chip colors |
| `server/sessionQuestions.js` | Parse + normalize questions |
| `server/sessionTranscript.js` | Keep `questions` / `answers` on the tool entry |
| `server/sessionTranscript.test.js` | Canned `ask_user_question` update |
| `AGENTS.md` / `README.md` | One row: in-chat multiple choice |

**Card states**

- `pending` — buttons enabled  
- `submitting` — buttons disabled, “Sending…”  
- `answered` — show chosen label(s); Other text visible  
- `expired` — turn cancelled / session switched; “Grok moved on. Send a message if you still want to choose.”

**Keyboard (desktop)**

- `1`–`9` select that option when the card is focused  
- Enter confirms Other text  
- Esc does **not** steal from “stop recording / stop turn”

**Access control**

- Phone uses the same PC permission mode. Cards must work on the phone.  
- Do not take answers from a query string. POST body only, cookie auth like other APIs.

**CSP**

- No new script origins. Cards are DOM + existing `app.js`.  
- Previews that are `http(s)` links can be mentioned as text; do not embed arbitrary remote images in phase 1 (`img-src 'self' data: blob:`).

---

## Suggested implementation order

1. **Spike (no UI):** log raw `ask_user_question` events from one live Desktop turn. Confirm payload shape and whether `-p` waits.  
2. **Parser + tests** for `extractAskUserQuestions`.  
3. **History render:** if a past tool entry has questions, show an answered/expired card.  
4. **Live card** on `tool_call` / `tool_call_update`.  
5. **Submit → next-turn answer block** + queue / interrupt behavior.  
6. **Mobile tap / stepper** for multi-question.  
7. **Phase 2 ACP** only if the spike says `-p` cannot wait.

Each step should be shippable. 1–5 is a useful product even if Grok sometimes answers itself first — the user can still override on the next turn.

---

## Risks

| Risk | Mitigation |
|---|---|
| `-p` never emits the tool | Spike first; fall back to detecting “Waiting on answers” text only as a last resort (fragile — do not rely on it) |
| Process hangs with stdin ignored | Watchdog already exists; Stop + send answers |
| Process auto-picks option 1 | Card still sends an override follow-up: “Use this choice instead: …” |
| Two questions while a follow-up is queued | One pending card per session; newest replaces or stacks below, do not lose answers |
| Hostile option labels / HTML | Treat labels as text (`textContent`), same as tool chips |
| Phone rotation / dropped SSE | Persist pending questions on the run record (`/api/runs`) so a reconnect can redraw the card |

---

## Out of scope for this upgrade

- Plan-mode approve/comment UI (`/plan`) — separate feature  
- File-level “Allow this command?” prompts (permission `default` / `acceptEdits`) — related, but a different event  
- Option `preview` images from the internet  
- Changing Access control away from Full vs Safer  

Those can reuse the same card primitive later (approve / deny / comment).

---

## Done when

- Typing a prompt that should ask a preference shows a card, not only an “Ask” chip.  
- Clicking an option (or Other) continues the same session with that choice.  
- Reopening the session still shows what was asked and what you picked.  
- Phone and desktop share the same card.  
- No tokens or file paths leak into the card UI.

---

## First PR sketch (smallest useful)

`extractAskUserQuestions` + live card + “You chose X” follow-up prompt.

Do not wait for ACP to start. If the spike shows `-p` drops the tool, the PR still lands the card for history and the next-turn override; ACP is PR 2.
