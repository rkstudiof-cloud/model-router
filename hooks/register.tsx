import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Decision,
  Effort,
  Forced,
  LogEntry,
  RouterMode,
  RouterStats,
  ModelTier,
  TurnLock,
} from '../types'
import {
  CLASSIFIER_LABELS,
  EMPTY_STATS,
  LABEL,
  addStats,
  decide,
  estUsd,
  formatStats,
  fromClassifier,
  guardSwitch,
  guidance,
  isEffort,
  isTier,
  money,
  tierOf,
} from './route'

const P = 'model-router'

// Bump a shape tag when that value's fields change: older stored values are then read as the initial one.
const decision = atom({ plugin: 'model-router', key: 'decision' } as const, null, { shape: 'decision-1' })
const stats = atom({ plugin: 'model-router', key: 'stats' } as const, EMPTY_STATS, { shape: 'stats-1' })
const mode = atom({ plugin: 'model-router', key: 'mode' } as const, 'auto' as RouterMode)
const forced = atom({ plugin: 'model-router', key: 'forced' } as const, null as Forced | null)
const failStreak = atom({ plugin: 'model-router', key: 'failStreak' } as const, 0)
const sessionModel = atom({ plugin: 'model-router', key: 'sessionModel' } as const, null as string | null)
const running = atom({ plugin: 'model-router', key: 'running' } as const, null as ModelTier | null)
const lock = atom({ plugin: 'model-router', key: 'lock' } as const, null as TurnLock | null)

const LIFETIME = 'lifetime-stats-1'
const LOG = 'decision-log-1'
const LOG_MAX = 300

type Config = {
  maxTier: ModelTier
  switchContextTokens: number
  useClassifier: boolean
  respectManualSwitch: boolean
  showBand: boolean
  escalateAfter: number
  classifierTimeoutMs: number
}

function config(options: Readonly<Record<string, unknown>>): Config {
  const s = (k: string) => (typeof options[k] === 'string' ? (options[k] as string) : undefined)
  const n = (k: string, d: number) => (typeof options[k] === 'number' && Number.isFinite(options[k]) ? (options[k] as number) : d)
  const b = (k: string, d: boolean) => (typeof options[k] === 'boolean' ? (options[k] as boolean) : d)
  const maxTier = s('maxTier')
  return {
    maxTier: maxTier && isTier(maxTier) ? maxTier : 'opus',
    switchContextTokens: n('switchContextTokens', 40000),
    useClassifier: b('useClassifier', true),
    respectManualSwitch: b('respectManualSwitch', true),
    showBand: b('showBand', true),
    escalateAfter: Math.max(1, Math.round(n('escalateAfter', 2))),
    classifierTimeoutMs: 4000,
  }
}

async function classify($: EngineInterface, text: string, ms: number): Promise<string | undefined> {
  const stop = new AbortController()
  const timeout = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => undefined,
    () => undefined,
  )
  try {
    return await Promise.race([
      $.model.classify(text.slice(0, 4000), CLASSIFIER_LABELS, { model: 'haiku' }).catch(() => undefined),
      timeout,
    ])
  } finally {
    stop.abort()
  }
}

async function addLifetime($: EngineInterface, delta: Partial<RouterStats>): Promise<void> {
  const prev = (await $.store.get(LIFETIME)) as RouterStats | undefined
  await $.store.set(LIFETIME, addStats(prev && typeof prev === 'object' && 'turns' in prev ? prev : EMPTY_STATS, delta))
}

async function bumpStats($: EngineInterface, delta: Partial<RouterStats>): Promise<void> {
  await update($, stats, s => addStats(s ?? EMPTY_STATS, delta))
  await addLifetime($, delta)
}

async function logDecision($: EngineInterface, text: string, d: Decision): Promise<void> {
  const prev = (await $.store.get(LOG)) as LogEntry[] | undefined
  const entry: LogEntry = {
    at: await $.clock.now(),
    snippet: text.replace(/\s+/g, ' ').slice(0, 60),
    tier: d.tier,
    effort: d.effort,
    delegate: d.delegate,
    source: d.source,
    reason: d.held ?? d.reason,
  }
  await $.store.set(LOG, [...(Array.isArray(prev) ? prev : []), entry].slice(-LOG_MAX))
}

export const describe = (d: Decision): string =>
  `${LABEL[d.tier]} · ${d.effort} · ${d.delegate}: ${d.held ?? d.reason}`

const HELP = [
  '/router            current mode and last decision',
  '/router stats      this session and all-time savings',
  '/router log        the last 15 decisions',
  '/router auto       resume automatic routing (clears a force)',
  '/router off        stop routing; the session model handles everything',
  '/router force <haiku|sonnet|opus> [low|medium|high]   pin a model until /router auto',
].join('\n')

export const register: Register = (on, options) => {
  const cfg = config(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Model router: status, stats, log, auto, off, force <model> [effort]',
      argumentHint: '[stats|log|auto|off|force <model> [effort]]',
    })
    await $.agent.register({
      name: 'scout',
      description:
        'Cheap read-only codebase explorer (Haiku). Use for broad searches across many files; it returns a short summary with file paths and line numbers, not file dumps.',
      prompt:
        'You are a fast, read-only code scout. Search the codebase to answer the question you are given. Never edit files. Reply with a compact summary: the answer, then the relevant file paths with line numbers and one line on each. No file dumps.',
      model: 'haiku',
      effort: 'low',
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Agent'],
      maxTurns: 40,
    })
    await $.agent.register({
      name: 'builder',
      description:
        'Implements one self-contained piece of work (Sonnet). Use for independent subtasks that can run in parallel; give it the exact files, the goal and what done looks like.',
      prompt:
        'You implement one well-scoped piece of work. Stay inside the files and goal you are given. When done, reply with what you changed (files, one line each), how you checked it, and anything left undone.',
      model: 'sonnet',
      effort: 'medium',
      disallowedTools: ['Agent'],
    })
    await $.agent.register({
      name: 'architect',
      description:
        'Read-only planner for design-heavy work (Opus, high effort). Use before multi-file refactors, migrations or architecture changes; it returns a short step-by-step plan.',
      prompt:
        'You are a senior architect. Read what you need, edit nothing, and return a concise plan: the approach and why, the files to change in order, risks, and how to verify. Keep it under 40 lines.',
      model: 'opus',
      effort: 'high',
      disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Agent'],
    })
    try {
      const model = await $.session.model()
      const known = await read($, sessionModel)
      if (known === null) await update($, sessionModel, () => model)
    } catch {
      // No model yet; prompt.submit records it.
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Slash commands, hidden prompts, and prompts folded into a running turn are not routed:
    // changing the model inside a turn would cost the prompt cache.
    if (e.command || e.isMeta || e.turnId !== undefined) return next(e)

    // The person changed the model themselves: stop overriding it.
    const now = await $.session.model()
    const known = await read($, sessionModel)
    if (known === null) {
      await update($, sessionModel, () => now)
    } else if (known !== now) {
      await update($, sessionModel, () => now)
      if (cfg.respectManualSwitch && (await read($, mode)) === 'auto' && (await read($, forced)) === null) {
        await update($, mode, () => 'paused-manual' as RouterMode)
        $.ui.toast(`Model router paused: you switched to ${now}. Run /router auto to resume.`)
      }
    }

    const m = await read($, mode)
    const f = await read($, forced)
    if (m !== 'auto' && f === null) {
      $.ui.status(m === 'off' ? 'router: off' : 'router: paused (manual model)')
      return next(e)
    }

    const last = await read($, decision)
    const out = decide({
      text: e.text,
      last,
      forced: f,
      failStreak: await read($, failStreak),
      maxTier: cfg.maxTier,
      escalateAfter: cfg.escalateAfter,
    })
    let d = out.decision
    const delta: Partial<RouterStats> = {}

    if (out.needsClassifier && cfg.useClassifier && e.text.trim().length >= 12) {
      const label = await classify($, e.text, cfg.classifierTimeoutMs)
      delta.classifierCalls = 1
      if (label !== undefined) {
        const g = fromClassifier(label, out.guess)
        const tier = g.tier === 'opus' && cfg.maxTier !== 'opus' ? cfg.maxTier : g.tier
        d = { tier, effort: g.effort, delegate: g.delegate === 'inline' ? out.guess.delegate : g.delegate, reason: g.reason, source: 'classifier' }
      }
    }

    const usage = await $.session.usage()
    // Before any reply is seen (new session, reload) nothing is "running" yet: treat the model the person
    // selected as the one holding the cache, so a first message cannot drop a long chat to a cheaper model.
    const selected = tierOf(now)
    const baseline = (await read($, running)) ?? (selected === 'other' ? null : selected)
    const guarded = guardSwitch(d, baseline, usage.context.tokens ?? 0, cfg.switchContextTokens)
    if (guarded.held) delta.heldSwitches = 1
    if (d.source === 'escalation') delta.escalations = 1
    if (d.source === 'override' || d.source === 'forced') delta.overrides = 1
    d = guarded

    await update($, decision, () => d)
    await update($, failStreak, () => out.failStreak)
    if (Object.keys(delta).length) await bumpStats($, delta)
    await logDecision($, e.text, d)
    $.ui.status(`router: ${LABEL[d.tier]} · ${d.effort}${d.delegate !== 'inline' ? ` · ${d.delegate}` : ''}`)

    const note = guidance(d, P)
    return next(note ? { ...e, context: [...(e.context ?? []), note] } : e)
  }).catch(($, e, next) => next(e))

  // Every model request of a turn. The model and effort are locked when the turn starts,
  // so tool steps inside one turn never switch model.
  on('turn.step', async function* ($, e, next) {
    let target: { model?: ModelTier; effort?: Effort } | null = null
    try {
      if (e.agentId === undefined) {
        const m = await read($, mode)
        const f = await read($, forced)
        if (m === 'auto' || f !== null) {
          let l = await read($, lock)
          if (l === null || l.turnId !== e.turnId) {
            const d = await read($, decision)
            const r = await read($, running)
            // A reload mid-turn: keep the model the turn has been running on.
            const tier = e.index === 0 ? (d?.tier ?? null) : r
            l = { turnId: e.turnId, tier, effort: e.index === 0 ? (d?.effort ?? null) : null }
            const fresh = l
            await update($, lock, () => fresh)
          }
          if (l.tier !== null) {
            const sameModel = tierOf(e.model) === l.tier
            const sameEffort = l.effort === null || e.effort === undefined || e.effort === l.effort
            if (!(sameModel && sameEffort)) {
              // Same family: keep the exact model id (an alias could name a newer version and lose the cache).
              target = sameModel ? {} : { model: l.tier }
              if (l.effort !== null && e.effort !== undefined && l.tier !== 'haiku') target.effort = l.effort
              if (target.model === undefined && target.effort === undefined) target = null
            }
          }
        }
      }
    } catch {
      target = null
    }

    const res = yield* next(target ? { ...e, ...target } : e)

    try {
      if (res.usage) {
        const actual = tierOf(res.usage.model)
        const base = tierOf(await read($, sessionModel))
        const steps = { haiku: 0, sonnet: 0, opus: 0, other: 0 }
        steps[actual] = 1
        await bumpStats($, {
          steps,
          estUsd: estUsd(actual, res.usage),
          // A subagent's calls are counted at the session model's price too: that is what it would have cost inline.
          baselineUsd: estUsd(base === 'other' ? actual : base, res.usage),
        })
        if (e.agentId === undefined && actual !== 'other') await update($, running, () => actual)
      }
    } catch {
      // Accounting never breaks a turn.
    }
    return res
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await bumpStats($, { turns: 1 })
      } catch {
        // ignore
      }
    }
    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const [sub = '', a = '', b = ''] = e.args.trim().toLowerCase().split(/\s+/)

    if (sub === 'auto' || sub === 'on') {
      await update($, mode, () => 'auto' as RouterMode)
      await update($, forced, () => null)
      // Take whatever model is selected now as the new baseline.
      await update($, sessionModel, () => null)
      return { text: 'Model router: automatic routing on.' }
    }
    if (sub === 'off') {
      await update($, mode, () => 'off' as RouterMode)
      await update($, forced, () => null)
      $.ui.status('router: off')
      return { text: 'Model router: off. The session model handles every message until /router auto.' }
    }
    if (sub === 'force') {
      if (!isTier(a)) return { text: `Usage: /router force <haiku|sonnet|opus> [low|medium|high]` }
      const effort: Effort = isEffort(b) ? b : a === 'opus' ? 'high' : a === 'haiku' ? 'low' : 'medium'
      await update($, forced, () => ({ tier: a, effort }))
      return { text: `Model router: pinned to ${LABEL[a]} at ${effort} effort until /router auto.` }
    }
    if (sub === 'stats') {
      const s = await read($, stats)
      const life = ((await $.store.get(LIFETIME)) as RouterStats | undefined) ?? EMPTY_STATS
      const usage = await $.session.usage()
      const real = usage.cost ? `\n  actual session cost (engine): ${money(usage.cost.usd)}` : ''
      return {
        text: `${formatStats(s, 'This session')}${real}\n\n${formatStats(life, 'All sessions')}\n\nCosts are estimates from the price table in hooks/route.ts.`,
      }
    }
    if (sub === 'log') {
      const log = ((await $.store.get(LOG)) as LogEntry[] | undefined) ?? []
      if (log.length === 0) return { text: 'Model router: no decisions logged yet.' }
      return {
        text: log
          .slice(-15)
          .map(l => `${LABEL[l.tier].padEnd(6)} ${l.effort.padEnd(6)} ${l.delegate.padEnd(13)} ${l.source.padEnd(10)} "${l.snippet}" (${l.reason})`)
          .join('\n'),
      }
    }
    if (sub === 'help') return { text: HELP }

    const d = await read($, decision)
    const m = await read($, mode)
    const f = await read($, forced)
    const state = f ? `forced to ${LABEL[f.tier]} · ${f.effort}` : m
    return {
      text: `Model router: ${state}\nLast decision: ${d ? describe(d) : 'none yet'}\n\n${HELP}`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!cfg.showBand || e.props.hasSurvey) return next(e)
    const d = await read($, decision)
    const m = await read($, mode)
    const f = await read($, forced)
    if (d === null && m === 'auto') return next(e)
    const s = await read($, stats)
    const saved = s.baselineUsd - s.estUsd
    const { Box, Button, Text } = $.ui.resolve(e)
    const active = m === 'auto' || f !== null
    const line = !active
      ? m === 'off'
        ? 'Router off'
        : 'Router paused: you picked the model'
      : d
        ? `Router: ${describe(d)}${f ? ' (forced)' : ''}`
        : 'Router: waiting for your next message'

    return (
      <Box flexDirection="row" flexWrap="wrap">
        <Text dimColor wrap="truncate-end">
          {line}
          {s.baselineUsd > 0 ? `  ·  saved ~${money(Math.max(0, saved))}` : ''}{' '}
        </Text>
        {active ? (
          <Button key="pause" plain label="Pause" onPress={() => update($, mode, () => 'off' as RouterMode)} />
        ) : (
          <Button
            key="resume"
            plain
            label="Resume"
            onPress={async () => {
              await update($, mode, () => 'auto' as RouterMode)
              await update($, sessionModel, () => null)
            }}
          />
        )}
      </Box>
    )
  })
}

export { HELP }
