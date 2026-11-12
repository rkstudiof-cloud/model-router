# model-router

A Claude Code mod that picks the **model**, **effort level** and **delegation strategy** for each message you send, to keep credit use down without losing quality.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install model-router --marketplace rkstudiof-cloud/model-router
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install model-router --marketplace rkstudiof-cloud/model-router
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `rkstudiof-cloud/model-router`, then Add plugin.

## What it does

For each message you type, the router:

1. **Classifies the task** with cheap keyword heuristics: task type, number of files mentioned, length, and list items. It falls back to one small Haiku classification call only when the heuristics are unsure (4 s timeout).
2. **Picks a tier.** Haiku/low for mechanical edits and quick questions, Sonnet/medium for normal coding, and Opus/high for architecture, security, tricky debugging and multi-file refactors.
3. **Locks that model for the whole turn.** Every model request in the turn (`turn.step`) uses it, so tool steps never switch models mid-turn.
4. **Asks before switching.** When it suggests a different model, it asks you first (`Switch to …` / `Stay on …`). Saying no, or closing the question, keeps your current model and effort for that message. Your own picks (`use opus`, `/router force`) are never asked about.
5. **Protects the prompt cache.** Each model has its own cache. On a long conversation (above `switchContextTokens`), a downgrade would re-read the whole context uncached, so the router keeps the current model and only lowers effort. Upgrades still go through.
5. **Suggests delegation** with a short note only the model reads, and only when it helps:
   - broad codebase search → `model-router:scout` (Haiku, read-only, returns a summary)
   - several independent parts → parallel `model-router:builder` subagents (Sonnet, at most 4)
   - design-heavy work → `model-router:architect` (Opus, read-only) plans first
   - an unrelated side task → suggest a separate session
6. **Escalates on failure.** After you report a failed fix `escalateAfter` times ("still failing", "same error"), it moves up one model at high effort. While a fix is in progress, it never drops to a cheaper model.
7. **Reuses the last decision for follow-ups** ("yes", "continue", "do it") and skips the classifier for them.

## Overrides

- In a message: `use opus`, `switch to haiku`, `go cheap`, `max effort`, `think hard`, `low effort`
- `/router force <haiku|sonnet|opus> [low|medium|high]` pins a model until `/router auto`
- `/router off` stops routing; `/router auto` resumes it
- If you change the session model yourself, the router pauses (see `respectManualSwitch`)

## Seeing what it does

- A one-line band above the prompt shows the decision and estimated savings, with a Pause/Resume button
- A status line entry shows the same in short form
- `/router stats` shows this session's and all-time estimated cost against your session model
- `/router log` shows the last 15 decisions with the reason for each

## Settings

| Option | Default | What it does |
|---|---|---|
| `maxTier` | `opus` | The highest model the router picks on its own |
| `switchContextTokens` | `40000` | Context size above which downgrades are held |
| `useClassifier` | `true` | Haiku fallback when the heuristics are unsure |
| `respectManualSwitch` | `true` | Pause when you change the model yourself |
| `showBand` | `true` | Show the band above the prompt |
| `escalateAfter` | `2` | Failed attempts before moving up a model |

## Limits

- Costs are **estimates** from the price table in `hooks/route.ts` (input, output, cache write at 1.25×, cache read at 0.1×). Edit it to match current pricing. `/router stats` also shows the engine's real session total.
- The baseline prices the same tokens at your session model's rate. It does not model how caching would have differed.
- Subagents run on their own pinned models. The router does not reroute them.
- Prompts typed while a turn is already running are not rerouted, to protect the cache.
