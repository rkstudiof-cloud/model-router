export type ModelTier = 'haiku' | 'sonnet' | 'opus'
export type Effort = 'low' | 'medium' | 'high'
export type Delegation = 'inline' | 'scout' | 'parallel' | 'plan-first' | 'split-session'
export type RouterMode = 'auto' | 'off' | 'paused-manual'
export type DecisionSource =
  | 'heuristic'
  | 'classifier'
  | 'override'
  | 'follow-up'
  | 'forced'
  | 'escalation'
  | 'default'

export type Decision = {
  tier: ModelTier
  effort: Effort
  delegate: Delegation
  reason: string
  source: DecisionSource
  /** Set when the cache guard kept the previous model instead of switching. */
  held?: string
  /** Set when the person turned down the suggested switch: the turn runs untouched. */
  declined?: boolean
}

export type Forced = { tier: ModelTier; effort: Effort }

/** The model a running turn is locked to, so a turn never switches mid-way. */
export type TurnLock = { turnId: string; tier: ModelTier | null; effort: Effort | null }

export type TierTally = { haiku: number; sonnet: number; opus: number; other: number }

export type RouterStats = {
  turns: number
  steps: TierTally
  /** Estimated dollars spent on the models the router picked. */
  estUsd: number
  /** Estimated dollars the same tokens would have cost on the session's own model. */
  baselineUsd: number
  classifierCalls: number
  escalations: number
  heldSwitches: number
  overrides: number
}

/**
 * A quality signal about one turn of work, or about a suggested switch.
 * accepted / correction / doubt / none: your next message, read in the light of the reply it
 * answers (none: a new request or status question, no verdict). interrupted: you stopped the
 * turn. switch-accepted / switch-declined: your answer to a suggested model switch.
 */
export type Signal =
  | 'accepted'
  | 'correction'
  | 'doubt'
  | 'none'
  | 'interrupted'
  | 'switch-accepted'
  | 'switch-declined'

export type Feedback = {
  at: number
  signal: Signal
  /** The model the signal is about: the one that did the judged turn, or the suggested one. */
  tier: ModelTier
  /** switch-*: the model you were on. */
  other?: ModelTier
  /** How the router chose for the judged turn, when it chose. */
  effort?: Effort
  source?: DecisionSource
  /** True when the judged turn ran on a different model than the one you selected. */
  routed?: boolean
  /** Who read the signal: Haiku, the fallback rules, or your own action. */
  by: 'haiku' | 'rules' | 'you'
  snippet: string
}

/** The last finished main-loop turn, kept so the reply to it can be judged. */
export type LastTurn = {
  turnId: string
  tier: ModelTier
  effort?: Effort
  source?: DecisionSource
  routed: boolean
  answerTail: string
}

export type LogEntry = {
  at: number
  snippet: string
  tier: ModelTier
  effort: Effort
  delegate: Delegation
  source: DecisionSource
  reason: string
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      decision: Shaped<Decision | null>
      mode: RouterMode
      forced: Forced | null
      stats: Shaped<RouterStats>
      failStreak: number
      sessionModel: string | null
      running: ModelTier | null
      lock: TurnLock | null
      lastTurn: LastTurn | null
      reaction: string | null
    }
  }
}
