import { describe, expect, test } from 'claude-code/testing'

import type { Decision } from '../types'
import { decide, detectOverride, guardSwitch, heuristic, isFollowUp } from '../hooks/route'

const base = { last: null, forced: null, failStreak: 0, maxTier: 'opus' as const, escalateAfter: 2 }

// [prompt, expected tier, expected delegation]
const CASES: ReadonlyArray<readonly [string, 'haiku' | 'sonnet' | 'opus', string]> = [
  ['rename getUser to fetchUser in api.ts', 'haiku', 'inline'],
  ['fix the typo in the README', 'haiku', 'inline'],
  ['what does this function return?', 'haiku', 'inline'],
  ['run the tests', 'haiku', 'inline'],
  ['remove unused imports from utils.ts', 'haiku', 'inline'],
  ['add a login form component with email and password validation', 'sonnet', 'inline'],
  ['fix the bug where the cart total crashes on empty carts', 'sonnet', 'inline'],
  ['write unit tests for the date parser', 'sonnet', 'inline'],
  ['update header.tsx and footer.tsx to use the new theme tokens', 'sonnet', 'inline'],
  ['find where formatPrice is used across the codebase', 'haiku', 'scout'],
  ['where is the auth middleware defined and called?', 'haiku', 'scout'],
  ['find all callers of chargeCard across the repo and fix the bug in each', 'sonnet', 'scout'],
  ['design the architecture for a multi-tenant billing system', 'opus', 'plan-first'],
  ['refactor the data layer across all modules to use the repository pattern', 'opus', 'plan-first'],
  ['there is a race condition in the job queue that causes intermittent duplicate charges', 'opus', 'inline'],
  ['audit the upload endpoint for security vulnerabilities like XSS and SQL injection', 'opus', 'inline'],
  ['migrate the app from webpack to vite', 'opus', 'plan-first'],
  ['please do these:\n1. add a dark mode toggle component\n2. add a settings page\n3. write tests for the settings page', 'sonnet', 'parallel'],
  ['add an export button to the report page, and separately in the background look into the CI cache', 'sonnet', 'split-session'],
]

describe('routing table', () => {
  for (const [prompt, tier, delegate] of CASES) {
    test(`${tier}/${delegate}: ${prompt.split('\n')[0]}`, () => {
      const { decision } = decide({ ...base, text: prompt })
      expect(decision.tier).toBe(tier)
      expect(decision.delegate).toBe(delegate)
    })
  }
})

describe('overrides and follow-ups', () => {
  test('"use opus" wins over the heuristic', () => {
    const { decision } = decide({ ...base, text: 'use opus to rename this variable' })
    expect(decision.tier).toBe('opus')
    expect(decision.source).toBe('override')
  })

  test('"go cheap" picks Haiku at low effort', () => {
    expect(detectOverride('go cheap on this one')).toEqual({ tier: 'haiku', effort: 'low' })
  })

  test('"max effort" raises effort and keeps the guessed model', () => {
    const { decision } = decide({ ...base, text: 'add a settings page component, max effort' })
    expect(decision.tier).toBe('sonnet')
    expect(decision.effort).toBe('high')
  })

  test('a forced model beats everything', () => {
    const { decision } = decide({ ...base, text: 'design the architecture', forced: { tier: 'haiku', effort: 'low' } })
    expect(decision.tier).toBe('haiku')
    expect(decision.source).toBe('forced')
  })

  test('a follow-up reuses the last decision with no classifier call', () => {
    const last: Decision = { tier: 'opus', effort: 'high', delegate: 'plan-first', reason: 'architecture', source: 'heuristic' }
    const out = decide({ ...base, text: 'yes, do it', last })
    expect(isFollowUp('yes, do it')).toBe(true)
    expect(out.decision.tier).toBe('opus')
    expect(out.decision.delegate).toBe('inline')
    expect(out.needsClassifier).toBe(false)
  })

  test('the router never goes above maxTier on its own', () => {
    const { decision } = decide({ ...base, maxTier: 'sonnet', text: 'design the architecture for the billing system' })
    expect(decision.tier).toBe('sonnet')
  })

  test('an unclear prompt asks for the classifier', () => {
    expect(decide({ ...base, text: 'hmm, thoughts on this approach overall' }).needsClassifier).toBe(true)
    expect(heuristic('rename foo to bar').confident).toBe(true)
  })
})

describe('escalation', () => {
  const last: Decision = { tier: 'sonnet', effort: 'medium', delegate: 'inline', reason: 'bug fix', source: 'heuristic' }

  test('the first failure stays on the same model', () => {
    const out = decide({ ...base, text: 'still failing', last })
    expect(out.decision.tier).toBe('sonnet')
    expect(out.failStreak).toBe(1)
  })

  test('the second failure in a row moves up a model at high effort', () => {
    const out = decide({ ...base, text: 'same error again', last, failStreak: 1 })
    expect(out.decision.tier).toBe('opus')
    expect(out.decision.effort).toBe('high')
    expect(out.decision.source).toBe('escalation')
  })

  test('a failure while on Haiku never drops further and resets after success', () => {
    const haikuLast: Decision = { ...last, tier: 'haiku', effort: 'low' }
    expect(decide({ ...base, text: "that's wrong", last: haikuLast }).decision.effort).toBe('medium')
    expect(decide({ ...base, text: 'add a footer component', last, failStreak: 1 }).failStreak).toBe(0)
  })
})

describe('cache guard', () => {
  const cheap: Decision = { tier: 'haiku', effort: 'low', delegate: 'inline', reason: 'mechanical edit', source: 'heuristic' }

  test('a downgrade on a long context keeps the running model', () => {
    const d = guardSwitch(cheap, 'opus', 120_000, 40_000)
    expect(d.tier).toBe('opus')
    expect(d.effort).toBe('low')
    expect(d.held).toMatch(/120k tokens/)
  })

  test('a downgrade on a short context goes through', () => {
    expect(guardSwitch(cheap, 'opus', 5_000, 40_000).tier).toBe('haiku')
  })

  test('an upgrade always goes through', () => {
    expect(guardSwitch({ ...cheap, tier: 'opus' }, 'haiku', 120_000, 40_000).tier).toBe('opus')
  })

  test('an explicit override is never held', () => {
    expect(guardSwitch({ ...cheap, source: 'override' }, 'opus', 120_000, 40_000).tier).toBe('haiku')
  })
})
