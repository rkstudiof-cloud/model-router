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
    }
  }
}
