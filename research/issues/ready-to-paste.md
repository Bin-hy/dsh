# Ready-to-Paste Issue Texts (English)

> 第四季交付：可直接粘贴到 GitHub 的英文 issue 文本。按优先级排列，粘贴前请替换 `[fill]` 处并附上复现脚本（本目录 issue-cordis-disposablelist-unshift.md 内有完整版）。

---

## Issue 1 · cordis: TypeError on non-global internal/update listener with prepend

**Repo**: deepseek-ai/DeepSeek-Harness (vendored `vendor/cordis`) — also reproducible on published `@deepseek-ai/cordis@4.0.1`

**Title**: `cordis: TypeError registering a non-global internal/update listener with prepend: true`

**Body**:

```markdown
## Summary

`ctx.on('internal/update', fn, { prepend: true })` without `global: true` throws
`TypeError: ... is not a function` at registration time. The `{ global: true,
prepend: true }` variant works.

## Repro

import { Context } from '@deepseek-ai/cordis'

const root = new Context()
root.plugin({
  name: 'repro',
  apply(ctx) {
    ctx.on('internal/update', () => {}, { prepend: true })              // TypeError
    ctx.on('internal/update', () => {}, { global: true, prepend: true }) // OK
  },
})

## Root cause

The `internal/listener` interceptor special-cases non-global `internal/update`
listeners into `fiber._hooks['internal/update']`, a `DisposableList`
(`vendor/cordis/src/events.ts:141-145`):

    const hooks = this.fiber._hooks['internal/update'] ??= new DisposableList()
    const method = options.prepend ? 'unshift' : 'push'
    return hooks[method](listener)

`DisposableList` (`vendor/cordis/src/utils.ts`) implements `push`, `delete`,
`clear`, and iteration — but no `unshift`. The ordinary hooks path
(`events.ts:255`) uses Array.prototype.unshift and is unaffected.

## Impact

Latent today (every in-repo `internal/update` registrant passes `global: true`),
but any future plugin that prepends a non-global update hook fails at load time
with a TypeError that does not point at the root cause.

## Suggested fixes

1. Add `unshift` to `DisposableList` (minimal).
2. Or fail loudly in the interceptor with a descriptive error when
   `prepend && !global` is requested for `internal/update`, if the combination
   is intentionally unsupported.

Related: `fiber._hooks` is never cleared in `_unload`
(`vendor/cordis/src/fiber.ts:675-694`); entries only die via their individual
disposers. Worth evaluating together.
```

---

## Issue 2 · llm-retry README contradicts implementation

**Repo**: deepseek-ai/DeepSeek-Harness

**Title**: `dsh-llm-retry README says retry "opens a retry turn"; the implementation retries within the same step`

**Body**:

```markdown
## Summary

`packages/llm/llm-retry/README.md:5` says "every retry opens a fresh numbered
turn", and line 11 says "The loop then closes the failed turn and opens a retry
turn". The implementation retries inside the same `(turn, step)`.

## Evidence

- `packages/core/agent-loop/src/agent.ts:339-371` — the retry path is
  `while (true) { ...; continue }` inside `step()`, not a new step/turn.
- `packages/llm/llm-retry/tests/retry.spec.ts:795` asserts exactly one
  `step/start` event across a retried request.

## Suggested fix

Reword to: "a retry is a new request attempt within the same `(turn, step)`;
new `assistant/chunk` events are logged for every attempt, while only the
successful attempt's chunks enter the final message's `sourceEventSeqs`."
```

---

## Issue 3 · cordis: internal/listener type declaration lagging

**Repo**: deepseek-ai/DeepSeek-Harness (vendored) or cordiverse/cordis

**Title**: `cordis: Events['internal/listener'] declares prepend: boolean, dispatch passes EventOptions`

**Body**:

```markdown
`vendor/cordis/src/events.ts:349` declares:

    'internal/listener'(this: Context, name: string, listener: any, prepend: boolean): void

but `events.ts:296` dispatches the normalized options object
(`{ prepend, global }`, normalized at line 290), and the interceptor at
line 140 already types it as `EventOptions`. Runtime behavior is consistent
(both sides use the object); only the declaration lies. Suggested fix:
`options: EventOptions | boolean`.
```

---

## Issue 4 · (doc suggestion) SessionWriteBehind.pending has no memory bound

**Repo**: deepseek-ai/DeepSeek-Harness

**Title**: `dsh-session-persistence: write-behind pending buffer has no memory bound during persistent write failures`

**Body**:

```markdown
`packages/session/session-persistence/src/write-behind.ts:44-58` — `enqueue`
appends every event to `pending` with no length or byte cap. Under normal
operation the 200ms fixed window bounds it, but during a persistent backend
failure (batch restored to the front of `pending`, automatic retries paused),
incoming events keep accumulating, so memory grows linearly with the event
rate for the outage's duration.

The repo's own "Apply bounds to the complete result" discipline covers tool
outputs and terminal scrollback; the write buffer's in-memory bound appears
to be the missing case. Suggested direction: byte cap + backpressure, with
`flush` reporting the overflow explicitly.
```

---

## Issue 5 · (doc suggestion) skill-badge disabled by default with no rationale

**Repo**: deepseek-ai/DeepSeek-Harness

**Title**: `base bundle disables skill-badge without documenting why`

**Body**:

```markdown
`packages/bundle/base/cordis.patch.yml:243-245` disables `skill-badge` with no
comment or doc explaining the default. Presets can enable it in one line, but
users deciding whether to do so have no stated rationale to weigh. A one-line
comment (product choice: keep the "powered by dsh" badge skill out of every
deployment's catalog by default) would resolve it.
```

---

## 提交顺序建议

1. Issue 1（最有价值，已复现）
2. Issue 4（真实缺口）
3. Issue 2（文档 bug，最快被接受）
4. Issue 3（类型小修）
5. Issue 5（一行注释的 PR，适合作为第一个"贡献 upstream"的练习）

提交 Issue 1 时把仓库切成两个：`@deepseek-ai/cordis@4.0.1` 的复现证明对 cordiverse/cordis 也有意义（先确认上游 master 是否已修）。
