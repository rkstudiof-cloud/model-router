// Pure routing logic: no `$`, so the tests can drive it directly.
import type {
  Feedback,
  Signal,
  Decision,
  Delegation,
  Effort,
  Forced,
  RouterStats,
  ModelTier,
} from '../types'

export const TIERS: readonly ModelTier[] = ['haiku', 'sonnet', 'opus']
export const rank = (t: ModelTier): number => TIERS.indexOf(t)
export const maxOf = (a: ModelTier, b: ModelTier): ModelTier => (rank(a) >= rank(b) ? a : b)
export const minOf = (a: ModelTier, b: ModelTier): ModelTier => (rank(a) <= rank(b) ? a : b)
export const bump = (t: ModelTier): ModelTier => TIERS[Math.min(rank(t) + 1, 2)] ?? 'opus'

export const LABEL: Record<ModelTier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

export function tierOf(model: string | null | undefined): ModelTier | 'other' {
  if (!model) return 'other'
  if (/opus/i.test(model)) return 'opus'
  if (/sonnet/i.test(model)) return 'sonnet'
  if (/haiku/i.test(model)) return 'haiku'
  return 'other'
}

export const isTier = (s: string): s is ModelTier => (TIERS as readonly string[]).includes(s)
export const isEffort = (s: string): s is Effort => s === 'low' || s === 'medium' || s === 'high'

// ---------------------------------------------------------------- overrides

export type Override = { tier?: ModelTier; effort?: Effort }

export function detectOverride(text: string): Override | null {
  const t = text.toLowerCase()
  const o: Override = {}
  const named = t.match(/\b(?:use|switch to|run (?:this )?on)\s+(?:the\s+)?(haiku|sonnet|opus)\b/)
  if (named?.[1] && isTier(named[1])) o.tier = named[1]
  if (/\b(?:go|be|stay|keep it) cheap\b|\bcheap mode\b|\bsave (?:credits|tokens)\b/.test(t)) {
    o.tier ??= 'haiku'
    o.effort ??= 'low'
  }
  if (/\bmax(?:imum)? effort\b|\bthink (?:really |very )?hard(?:er)?\b|\bultrathink\b/.test(t)) {
    o.effort = 'high'
  }
  if (/\blow effort\b|\bquick and dirty\b/.test(t)) o.effort ??= 'low'
  return o.tier || o.effort ? o : null
}

// ---------------------------------------------------------------- follow-ups and failures

const FOLLOW_UP =
  /^(?:y(?:es|ep|eah|up)?|ok(?:ay)?|k|sure|go(?: ahead| for it)?|do it|yes,? do it|continue|keep going|proceed|next|thanks?(?: you)?|ty|lgtm|sounds good|perfect|great|nice|cool|works|done|👍)[.!\s]*$/i

export const isFollowUp = (text: string): boolean => {
  const s = text.trim()
  return s.length > 0 && s.length <= 40 && FOLLOW_UP.test(s)
}

const FAILURE =
  /\b(?:still (?:fail|broken|not work|wrong|error|crash)|(?:doesn'?t|does not|didn'?t|did not|isn'?t|is not) work|same (?:error|issue|problem|bug)|that'?s (?:wrong|not (?:it|right))|not fixed|wrong again|broke (?:it|again)|didn'?t fix)/i

export const isFailureReport = (text: string): boolean => FAILURE.test(text)

// ---------------------------------------------------------------- quality signals

/**
 * What a new message says about the model that answered the previous one, or null when it
 * says nothing. Read from the person's own words only; never guessed from the answer.
 */
export function judge(text: string): { signal: 'fail' | 'override' | 'ok'; asked?: ModelTier } | null {
  if (isFailureReport(text)) return { signal: 'fail' }
  const o = detectOverride(text)
  if (o?.tier) return { signal: 'override', asked: o.tier }
  if (isFollowUp(text)) return { signal: 'ok' }
  return null
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '-')

export function formatQuality(list: readonly Feedback[]): string {
  if (list.length === 0) return 'Model router: no quality signals yet. They build up as you work.'
  const lines = ['Quality signals (from your own words and choices):', '']
  lines.push('Model   judged  ok    fail  overridden')
  for (const t of TIERS) {
    const mine = list.filter(f => f.tier === t && (f.signal === 'ok' || f.signal === 'fail' || f.signal === 'override'))
    if (!mine.length) continue
    const n = (s: Signal) => mine.filter(f => f.signal === s).length
    lines.push(`${LABEL[t].padEnd(8)}${String(mine.length).padEnd(8)}${pct(n('ok'), mine.length).padEnd(6)}${pct(n('fail'), mine.length).padEnd(6)}${pct(n('override'), mine.length)}`)
  }
  const asked = list.filter(f => f.signal === 'accepted' || f.signal === 'declined')
  if (asked.length) {
    lines.push('', 'Suggested switches:')
    for (const t of TIERS) {
      const to = asked.filter(f => f.tier === t)
      if (!to.length) continue
      const yes = to.filter(f => f.signal === 'accepted').length
      lines.push(`  to ${LABEL[t].padEnd(7)} asked ${to.length}, accepted ${pct(yes, to.length)}`)
    }
  }
  lines.push('', `${list.length} signals in all. "ok" means you moved on without complaint, not that the answer was rated.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- heuristics

type Rule = { re: RegExp; w: number; why: string }

const HARD: Rule[] = [
  { re: /\barchitect(?:ure)?\b|\bsystem design\b|\bdesign (?:a|the|an) (?:system|architecture|schema|data model)\b/i, w: 3, why: 'architecture' },
  { re: /\brefactor\b.*\b(?:across|whole|entire|all|every|codebase|modules)\b|\bmigrat(?:e|ion)\b/i, w: 3, why: 'multi-file refactor or migration' },
  { re: /\bsecurity\b|\bvulnerab|\bxss\b|\bsql injection\b|\bcsrf\b|\bauth(?:entication|orization)? (?:bug|flaw|hole|bypass)/i, w: 3, why: 'security' },
  { re: /\brace condition|\bdeadlock|\bmemory leak|\bconcurren|\bflaky\b|\bintermittent|\bheisenbug/i, w: 3, why: 'tricky debugging' },
  { re: /\broot cause\b|\bwhy (?:does|is|isn'?t|doesn'?t|would|did|do)\b/i, w: 2, why: 'root-cause analysis' },
  { re: /\b(?:optimi[sz]e|performance|latency|bottleneck|scalab)/i, w: 2, why: 'performance work' },
  { re: /\btrade-?offs?\b|\bcompare (?:approaches|options|designs)\b|\bpros and cons\b/i, w: 2, why: 'design trade-offs' },
]

const STANDARD: Rule[] = [
  { re: /\b(?:implement|build|create|add|make)\b.*\b(?:feature|endpoint|component|page|api|function|class|module|screen|hook|form|route|script|cli)s?\b/i, w: 2, why: 'feature work' },
  { re: /\bfix\b.*\b(?:bug|error|crash|issue|exception|failing|test)s?\b|\bdebug\b/i, w: 2, why: 'bug fix' },
  { re: /\b(?:write|add|update) (?:some |the )?(?:unit |integration |e2e )?tests?\b/i, w: 2, why: 'tests' },
  { re: /\brefactor\b/i, w: 1, why: 'refactor' },
  { re: /\breview\b|\bexplain how\b/i, w: 1, why: 'review or explanation' },
]

const TRIVIAL: Rule[] = [
  { re: /\b(?:rename|typo|spelling|reformat|format|lint|indent|bump (?:the )?version|add (?:a )?comment|remove (?:unused|dead) (?:imports?|code))\b/i, w: 2, why: 'mechanical edit' },
  { re: /^(?:what|where|which|who|when|how many|is there|does|list|show)\b/i, w: 1, why: 'quick question' },
  { re: /\b(?:summari[sz]e|translate|tl;?dr|one-liner|regex for)\b/i, w: 1, why: 'small text task' },
  { re: /\b(?:git (?:status|log|diff)|run (?:the )?tests?|commit (?:this|it|these))\b/i, w: 2, why: 'routine command' },
]

const SEARCH =
  /\b(?:find|search|look|grep|locate|trace)\b.*\b(?:across|throughout|in|through) (?:the )?(?:whole |entire )?(?:codebase|repo(?:sitory)?|project|monorepo)\b|\bwhere (?:is|are)\b.*\b(?:used|defined|called|referenced|imported)\b|\ball (?:usages|references|callers|call sites)\b/i

const SIDE =
  /\b(?:separately|in (?:the )?background|meanwhile|side (?:task|quest)|in a (?:new|separate) session)\b/i

const FILES =
  /\b[\w./-]+\.(?:tsx?|jsx?|py|rb|go|rs|java|kt|swift|cs|cpp|c|h|vue|svelte|css|scss|sql|ya?ml|json|md)\b/gi

function score(rules: Rule[], text: string): { w: number; why: string[] } {
  let w = 0
  const why: string[] = []
  for (const r of rules) {
    if (r.re.test(text)) {
      w += r.w
      why.push(r.why)
    }
  }
  return { w, why }
}

export function listItems(text: string): number {
  return text.split('\n').filter(l => /^\s*(?:\d+[.)]|[-*•])\s+\S/.test(l)).length
}

export function fileCount(text: string): number {
  return new Set((text.match(FILES) ?? []).map(f => f.toLowerCase())).size
}

export type Guess = {
  tier: ModelTier
  effort: Effort
  delegate: Delegation
  reason: string
  confident: boolean
}

export function heuristic(text: string): Guess {
  const hard = score(HARD, text)
  const std = score(STANDARD, text)
  const triv = score(TRIVIAL, text)
  const files = fileCount(text)
  const items = listItems(text)
  const long = text.length > 1500

  let tier: ModelTier
  let effort: Effort
  let why: string[]
  let confident = true

  if (hard.w >= 3 || (hard.w >= 2 && (files >= 2 || long || std.w > 0)) || (hard.w >= 1 && files >= 3)) {
    tier = 'opus'
    effort = hard.w >= 3 ? 'high' : 'medium'
    why = hard.why
  } else if (hard.w >= 2) {
    // One medium-strength hard signal alone, like a "why does" question.
    tier = 'sonnet'
    effort = 'high'
    why = hard.why
    confident = false
  } else if (std.w >= 1 || files >= 2 || long || items >= 3) {
    tier = 'sonnet'
    effort = 'medium'
    why = std.why.length ? std.why : [files >= 2 ? `${files} files` : long ? 'long request' : 'multi-part request']
    if (triv.w >= 2 && std.w <= 1) confident = false
  } else if (triv.w >= 1) {
    tier = 'haiku'
    effort = 'low'
    why = triv.why
  } else {
    tier = 'sonnet'
    effort = 'medium'
    why = ['no strong signal']
    confident = false
  }

  let delegate: Delegation = 'inline'
  if (SIDE.test(text)) delegate = 'split-session'
  else if (SEARCH.test(text)) delegate = 'scout'
  else if (items >= 3 && tier !== 'haiku' && hard.w === 0) delegate = 'parallel'
  else if (tier === 'opus' && hard.why.some(w => w === 'architecture' || w.startsWith('multi-file'))) delegate = 'plan-first'

  if (delegate === 'scout') why = [...why.filter(w => w !== 'no strong signal'), 'broad codebase search']
  // A pure search: the Haiku scout does the reading, so the main thread can be cheap too.
  if (delegate === 'scout' && hard.w === 0 && std.w === 0) {
    tier = 'haiku'
    effort = 'low'
    confident = true
  }

  return { tier, effort, delegate, reason: why.join(', '), confident }
}

// ---------------------------------------------------------------- classifier

export const CLASSIFIER_LABELS = [
  'trivial-edit-or-quick-question',
  'normal-coding-task',
  'hard-reasoning-debugging-or-architecture',
  'broad-codebase-search',
  'several-independent-subtasks',
] as const

export function fromClassifier(label: string | undefined, fallback: Guess): Guess {
  switch (label) {
    case 'trivial-edit-or-quick-question':
      return { tier: 'haiku', effort: 'low', delegate: 'inline', reason: 'classifier: trivial', confident: true }
    case 'normal-coding-task':
      return { tier: 'sonnet', effort: 'medium', delegate: 'inline', reason: 'classifier: standard task', confident: true }
    case 'hard-reasoning-debugging-or-architecture':
      return { tier: 'opus', effort: 'high', delegate: 'inline', reason: 'classifier: hard task', confident: true }
    case 'broad-codebase-search':
      return { tier: 'haiku', effort: 'low', delegate: 'scout', reason: 'classifier: codebase search', confident: true }
    case 'several-independent-subtasks':
      return { tier: 'sonnet', effort: 'medium', delegate: 'parallel', reason: 'classifier: independent subtasks', confident: true }
    default:
      return fallback
  }
}

// ---------------------------------------------------------------- decision

export type DecideInput = {
  text: string
  last: Decision | null
  forced: Forced | null
  failStreak: number
  maxTier: ModelTier
  escalateAfter: number
}

export type DecideOutput = {
  decision: Decision
  failStreak: number
  /** True when the heuristics were unsure and a classifier call may refine the guess. */
  needsClassifier: boolean
  guess: Guess
}

export function decide(input: DecideInput): DecideOutput {
  const { text, last, forced, maxTier, escalateAfter } = input
  const guess = heuristic(text)

  if (forced) {
    return {
      decision: { ...forced, delegate: guess.delegate, reason: `forced with /router force`, source: 'forced' },
      failStreak: 0,
      needsClassifier: false,
      guess,
    }
  }

  const override = detectOverride(text)
  if (override) {
    const tier = override.tier ?? guess.tier
    return {
      decision: {
        tier,
        effort: override.effort ?? guess.effort,
        delegate: guess.delegate,
        reason: `you asked for ${override.tier ? LABEL[override.tier] : ''}${override.tier && override.effort ? ', ' : ''}${override.effort ? `${override.effort} effort` : ''}`,
        source: 'override',
      },
      failStreak: 0,
      needsClassifier: false,
      guess,
    }
  }

  if (isFollowUp(text) && last) {
    return {
      decision: { ...last, delegate: 'inline', source: 'follow-up', reason: `follow-up, same as before (${last.reason})`, held: undefined },
      failStreak: input.failStreak,
      needsClassifier: false,
      guess,
    }
  }

  if (isFailureReport(text) && last) {
    const streak = input.failStreak + 1
    if (streak >= escalateAfter) {
      const tier = minOf(bump(maxOf(last.tier, guess.tier)), maxOf(maxTier, last.tier))
      return {
        decision: { tier, effort: 'high', delegate: 'inline', reason: `escalated after ${streak} failed attempts`, source: 'escalation' },
        failStreak: streak,
        needsClassifier: false,
        guess,
      }
    }
    // Mid-fix: never drop below the model already working on it.
    return {
      decision: { tier: maxOf(last.tier, guess.tier), effort: last.effort === 'low' ? 'medium' : last.effort, delegate: 'inline', reason: 'retrying a fix on the same model', source: 'heuristic' },
      failStreak: streak,
      needsClassifier: false,
      guess,
    }
  }

  const tier = minOf(guess.tier, maxTier)
  return {
    decision: {
      tier,
      effort: guess.effort,
      delegate: guess.delegate,
      reason: guess.reason + (tier !== guess.tier ? ` (capped at ${LABEL[maxTier]})` : ''),
      source: guess.confident ? 'heuristic' : 'default',
    },
    failStreak: 0,
    needsClassifier: !guess.confident,
    guess,
  }
}

/**
 * Each model keeps its own prompt cache. Switching the main thread to a cheaper
 * model on a long conversation makes it re-read the whole context uncached, which
 * can cost more than it saves, so above `limit` tokens a downgrade is held.
 * Upgrades still go through: a hard task is worth the re-read.
 */
export function guardSwitch(d: Decision, running: ModelTier | null, contextTokens: number, limit: number): Decision {
  if (!running || d.tier === running || contextTokens < limit) return d
  if (d.source === 'forced' || d.source === 'override' || d.source === 'escalation') return d
  if (rank(d.tier) < rank(running)) {
    const k = Math.round(contextTokens / 1000)
    return {
      ...d,
      tier: running,
      held: `kept ${LABEL[running]}: a switch to ${LABEL[d.tier]} would re-read ~${k}k tokens uncached`,
    }
  }
  return d
}

// ---------------------------------------------------------------- delegation guidance

export function guidance(d: Decision, plugin: string): string | undefined {
  switch (d.delegate) {
    case 'scout':
      return `[${plugin}] This needs a broad codebase search. Delegate the searching to the \`${plugin}:scout\` subagent (Haiku, read-only) and work from its summary instead of reading many files yourself.`
    case 'parallel':
      return `[${plugin}] This has several independent parts. If each takes more than a few tool calls, run them in parallel as \`${plugin}:builder\` subagents (Sonnet), at most 4, then check their results. Do small parts yourself.`
    case 'plan-first':
      return `[${plugin}] This is design-heavy. Have the \`${plugin}:architect\` subagent (Opus, read-only) produce a short plan first, then implement it.`
    case 'split-session':
      return `[${plugin}] Part of this is a separate side task. Suggest it as its own session rather than doing it inline here.`
    default:
      return undefined
  }
}

// ---------------------------------------------------------------- cost estimates

/** Estimated list prices in US dollars per million tokens: [input, output]. Edit to match current pricing. */
export const PRICE: Record<ModelTier | 'other', readonly [number, number]> = {
  haiku: [1, 5],
  sonnet: [3, 15],
  opus: [5, 25],
  other: [5, 25],
}

export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function estUsd(tier: ModelTier | 'other', u: Usage): number {
  const [inp, out] = PRICE[tier]
  return (
    (u.input_tokens * inp +
      u.cache_creation_input_tokens * inp * 1.25 +
      u.cache_read_input_tokens * inp * 0.1 +
      u.output_tokens * out) /
    1e6
  )
}

export const EMPTY_STATS: RouterStats = {
  turns: 0,
  steps: { haiku: 0, sonnet: 0, opus: 0, other: 0 },
  estUsd: 0,
  baselineUsd: 0,
  classifierCalls: 0,
  escalations: 0,
  heldSwitches: 0,
  overrides: 0,
}

export function addStats(a: RouterStats, b: Partial<RouterStats>): RouterStats {
  const steps = b.steps ?? { haiku: 0, sonnet: 0, opus: 0, other: 0 }
  return {
    turns: a.turns + (b.turns ?? 0),
    steps: {
      haiku: a.steps.haiku + steps.haiku,
      sonnet: a.steps.sonnet + steps.sonnet,
      opus: a.steps.opus + steps.opus,
      other: a.steps.other + steps.other,
    },
    estUsd: a.estUsd + (b.estUsd ?? 0),
    baselineUsd: a.baselineUsd + (b.baselineUsd ?? 0),
    classifierCalls: a.classifierCalls + (b.classifierCalls ?? 0),
    escalations: a.escalations + (b.escalations ?? 0),
    heldSwitches: a.heldSwitches + (b.heldSwitches ?? 0),
    overrides: a.overrides + (b.overrides ?? 0),
  }
}

export const money = (n: number): string => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

export function formatStats(s: RouterStats, title: string): string {
  const saved = s.baselineUsd - s.estUsd
  const pct = s.baselineUsd > 0 ? Math.round((saved / s.baselineUsd) * 100) : 0
  return [
    `${title}`,
    `  turns: ${s.turns}   model calls: Haiku ${s.steps.haiku} · Sonnet ${s.steps.sonnet} · Opus ${s.steps.opus}${s.steps.other ? ` · other ${s.steps.other}` : ''}`,
    `  estimated cost: ${money(s.estUsd)}   on your session model: ${money(s.baselineUsd)}   saved: ${money(saved)} (${pct}%)`,
    `  classifier calls: ${s.classifierCalls}   escalations: ${s.escalations}   held switches: ${s.heldSwitches}   overrides: ${s.overrides}`,
  ].join('\n')
}
