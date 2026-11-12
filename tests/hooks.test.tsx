import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepInput } from 'claude-code'

type World = { model: string; contextTokens: number; classify?: string; classifyThrows?: boolean }

// The engine beneath the plugin: each hook answers a call the mod makes on `$`.
function world(on: On, w: World, steps: TurnStepInput[], statuses: string[]) {
  mock.store(on)
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'router' } }))
  on('agent.register', (_, e) => ({ value: { agent: `model-router:${e.name}` } }))
  on('session.model', () => ({ value: w.model }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: w.contextTokens, window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }))
  on('model.classify', () => {
    if (w.classifyThrows) throw new Error('api down')
    return { value: w.classify }
  })
  on('ui.status', (_, e) => {
    statuses.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    steps.push(e)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
  })
}

async function step($: Engine, turnId: string, index: number, model = 'claude-opus-5-5') {
  const s = $.turn.step({ turnId, index, model, effort: 'high', messageCount: 3 + index })
  for await (const _ of s) {
    // drain
  }
  return s.result
}

const submit = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

test('a trivial prompt runs on Haiku for every step of its turn', async ($, on) => {
  const steps: TurnStepInput[] = []
  world(on, { model: 'claude-opus-5-5', contextTokens: 2000 }, steps, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit(submit('rename getUser to fetchUser'))
  await step($, 't1', 0)
  await step($, 't1', 1)

  expect(steps.map(s => s.model)).toEqual(['haiku', 'haiku'])
  // Haiku gets no effort rewrite.
  expect(steps[0]?.effort).toBe('high')
})

test('a hard prompt on an Opus session passes through untouched', async ($, on) => {
  const steps: TurnStepInput[] = []
  world(on, { model: 'claude-opus-5-5', contextTokens: 2000 }, steps, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit(submit('there is a race condition in the job queue causing duplicate charges'))
  await step($, 't1', 0)

  expect(steps[0]?.model).toBe('claude-opus-5-5')
  expect(steps[0]?.effort).toBe('high')
})

test('a turn keeps its model even if a new decision lands mid-turn', async ($, on) => {
  const steps: TurnStepInput[] = []
  world(on, { model: 'claude-opus-5-5', contextTokens: 2000 }, steps, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit(submit('fix the typo in the README'))
  await step($, 't1', 0)
  // A prompt typed during the running turn is not routed.
  await $.prompt.submit({ ...submit('design the architecture for billing'), turnId: 't1' })
  await step($, 't1', 1)

  expect(steps.map(s => s.model)).toEqual(['haiku', 'haiku'])
})

test('delegation guidance reaches the model as hidden context', async ($, on) => {
  world(on, { model: 'claude-sonnet-5-5', contextTokens: 2000 }, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const out = await $.prompt.submit(submit('find where formatPrice is used across the codebase'))
  expect(out.drop).toBe(undefined)
  expect(String((out as { context?: readonly string[] }).context?.[0])).toMatch(/model-router:scout/)

  const plain = await $.prompt.submit(submit('rename foo to bar'))
  expect((plain as { context?: readonly string[] }).context ?? []).toEqual([])
})

test('the cache guard holds a downgrade on a long conversation', async ($, on) => {
  const steps: TurnStepInput[] = []
  const w = { model: 'claude-opus-5-5', contextTokens: 2000 }
  world(on, w, steps, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit(submit('design the architecture for a multi-tenant billing system'))
  await step($, 't1', 0)
  w.contextTokens = 150_000
  await $.prompt.submit(submit('fix the typo in the README'))
  await step($, 't2', 0, 'claude-opus-5-5')

  // Stayed on Opus (no model rewrite), effort lowered.
  expect(steps[1]?.model).toBe('claude-opus-5-5')
  expect(steps[1]?.effort).toBe('low')
})

test('the cache guard also holds the very first message of a long conversation', async ($, on) => {
  const steps: TurnStepInput[] = []
  // A reload or resume: the chat is already long and no reply has been seen yet.
  world(on, { model: 'claude-opus-5-5', contextTokens: 150_000 }, steps, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit(submit('fix the typo in the README'))
  await step($, 't1', 0, 'claude-opus-5-5')

  // Stayed on the selected Opus (no model rewrite).
  expect(steps[0]?.model).toBe('claude-opus-5-5')
})

test('a manual model change pauses the router', async ($, on) => {
  const steps: TurnStepInput[] = []
  const w = { model: 'claude-opus-5-5', contextTokens: 2000 }
  world(on, w, steps, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  w.model = 'claude-sonnet-5-5'
  await $.prompt.submit(submit('rename foo to bar'))
  await step($, 't1', 0, 'claude-sonnet-5-5')
  expect(steps[0]?.model).toBe('claude-sonnet-5-5')

  const status = await $.command.run({ command: 'router', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
  expect(status.text).toMatch(/paused-manual/)

  await $.command.run({ command: 'router', args: 'auto', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)
  await $.prompt.submit(submit('rename foo to bar'))
  await step($, 't2', 0, 'claude-sonnet-5-5')
  expect(steps[1]?.model).toBe('haiku')
})

test('a failing classifier falls back to the heuristic guess', async ($, on) => {
  const steps: TurnStepInput[] = []
  world(on, { model: 'claude-opus-5-5', contextTokens: 2000, classifyThrows: true }, steps, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.prompt.submit(submit('hmm, thoughts on this approach overall'))
  await step($, 't1', 0)
  expect(steps[0]?.model).toBe('sonnet')
})

test('/router force pins a model and stats count the savings', async ($, on) => {
  const steps: TurnStepInput[] = []
  world(on, { model: 'claude-opus-5-5', contextTokens: 2000 }, steps, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const run = (args: string) =>
    $.command.run({ command: 'router', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as never)

  await run('force sonnet')
  await $.prompt.submit(submit('design the architecture for billing'))
  await step($, 't1', 0)
  expect(steps[0]?.model).toBe('sonnet')

  const stats = await run('stats')
  expect(stats.text).toMatch(/Sonnet 1/)
  expect(stats.text).toMatch(/saved: \$/)
})

test('the band shows the decision on every surface and pauses on press', async ($, on) => {
  world(on, { model: 'claude-opus-5-5', contextTokens: 2000 }, [], [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit(submit('rename getUser to fetchUser'))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'model-router',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    } as never)
    expect((await ui.find({ type: 'Text', text: /Haiku · low/ }))?.text).toMatch(/mechanical edit/)
    await ui.unmount()
  }

  const ui = await $.ui.mount({
    plugin: 'model-router',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  } as never)
  await ui.press({ key: 'pause' })
  expect((await ui.find({ type: 'Text', text: /Router off/ }))?.text).toMatch(/Router off/)
  await ui.unmount()
})
