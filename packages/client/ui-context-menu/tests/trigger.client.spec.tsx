// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createPortal } from 'react-dom'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { createContextMenuBindings } from '../src/client/trigger.ts'
import type { ContextMenuTriggerProps, ContextMenuTarget } from '../src/client/types.ts'

afterEach(cleanup)
/** jsdom ships no PointerEvent; a plain bubbling Event carrying the fields React reads is enough. */
const pointer = (type: string, init: Record<string, unknown>): Event => Object.assign(
  new Event(type, { bubbles: true, cancelable: true }),
  { pointerType: 'touch', isPrimary: true, button: 0, clientX: 0, clientY: 0, ...init },
)
const target = (id: string): ContextMenuTarget => ({ kind: 'session', value: { sessionId: SessionId(id), displayTitle: id } })

it('binds targets in loops, captures deferred identity before focus changes it, and composes existing handlers', () => {
  const open = vi.fn(), previous = vi.fn(), clicked = vi.fn()
  let selected = 'first'
  const { getTriggerProps } = createContextMenuBindings(open, () => true)
  const view = render(<>
    {['one', 'two'].map(id => <button key={id} {...getTriggerProps(target(id), { onContextMenu: previous })}>{id}</button>)}
    <button {...getTriggerProps(() => target(selected), { tabIndex: -1 })} onFocus={() => { selected = 'changed' }} onClick={clicked}>Captured</button>
  </>)
  for (const id of ['one', 'two']) {
    fireEvent.contextMenu(view.getByRole('button', { name: id }), { clientX: 12, clientY: 23 })
    expect(open).toHaveBeenLastCalledWith(target(id), { x: 12, y: 23 })
  }
  expect(previous).toHaveBeenCalledTimes(2)
  const button = view.getByRole('button', { name: 'Captured' })
  button.getBoundingClientRect = () => new DOMRect(30, 40, 50, 20)
  const focus = vi.spyOn(button, 'focus')
  fireEvent.keyDown(button, { key: 'F10', shiftKey: true })
  expect(open).toHaveBeenLastCalledWith(target('first'), { x: 30, y: 60 })
  expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  expect(button.tabIndex).toBe(-1)
  expect(clicked).not.toHaveBeenCalled()
  fireEvent.contextMenu(button)
  expect(open).toHaveBeenLastCalledWith(target('changed'), { x: 30, y: 60 })
})

it('honors prevented and nested gestures, portals, repeats, composition, and missing targets', () => {
  const open = vi.fn(), outer = vi.fn(), existing = vi.fn()
  const bindings = createContextMenuBindings(open, () => true)
  const parent = createContextMenuBindings(outer, () => true)
  const inner = bindings.getTriggerProps(target('inner'))
  const composed = bindings.getTriggerProps(target('second'), inner)
  const view = render(<div {...parent.getTriggerProps(target('outer'))}>
    <button {...composed}>Inner</button>
    <button {...bindings.getTriggerProps(target('blocked'), {
      onContextMenu: (event) => { event.preventDefault() }, onKeyDown: (event) => { event.preventDefault() },
    })}>Blocked</button>
    <button {...bindings.getTriggerProps(undefined, { onKeyDown: existing })}>Native</button>
    {createPortal(<button {...inner}>Portal</button>, document.body)}
  </div>)
  const button = view.getByRole('button', { name: 'Inner' })
  fireEvent.contextMenu(button, { clientX: 1, clientY: 2 })
  fireEvent.keyDown(button, { key: 'ContextMenu' })
  expect(open).toHaveBeenCalledTimes(2)
  expect(open).toHaveBeenLastCalledWith(target('inner'), { x: 0, y: 0 })
  fireEvent.contextMenu(view.getByRole('button', { name: 'Blocked' }))
  fireEvent.keyDown(view.getByRole('button', { name: 'Blocked' }), { key: 'ContextMenu' })
  for (const extra of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { key: 'Enter' }]) {
    fireEvent.keyDown(button, { key: 'ContextMenu', ...extra })
  }
  const prevented = createEvent.contextMenu(button)
  prevented.preventDefault(); fireEvent(button, prevented)
  expect(open).toHaveBeenCalledTimes(2)
  fireEvent.contextMenu(view.getByRole('button', { name: 'Portal' }), { clientX: 4, clientY: 5 })
  expect(open).toHaveBeenCalledTimes(3)
  expect(outer).not.toHaveBeenCalled()
  fireEvent.keyDown(view.getByRole('button', { name: 'Native' }), { key: 'a' })
  expect(existing).toHaveBeenCalledOnce()
})

it('injects the hook through the root Slot and withdraws both its prop and retained handlers on unload', async () => {
  const runtime = await SlotTestRuntime.create()
  onTestFinished(() => runtime.dispose())
  runtime.ctx.provide('shortcuts', { catalog: createSnapshotStore([]) } as never)
  runtime.ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  let retained: ContextMenuTriggerProps = {}
  let received = false
  await runtime.root.declare({}, ({ useContextMenu }) => {
    received = typeof useContextMenu === 'function'
    if (!received) return null
    retained = useContextMenu().getTriggerProps(target('injected'))
    return <button {...retained}>Injected</button>
  })
  const plugin = await runtime.mount({ inject, apply })
  const view = runtime.renderRoot()
  expect(received).toBe(true)
  act(() => { fireEvent.contextMenu(view.getByRole('button')) })
  expect(runtime.ctx.contextMenus.active.getSnapshot()).toEqual(target('injected'))
  const source = runtime.ctx.contextMenus.active
  await plugin.dispose()
  expect(received).toBe(false)
  expect(source.getSnapshot()).toBeNull()
  const detached = render(<button {...retained}>Retained</button>)
  expect(fireEvent.contextMenu(detached.getByRole('button'))).toBe(true)
  expect(fireEvent.keyDown(detached.getByRole('button'), { key: 'ContextMenu' })).toBe(true)
  expect(source.getSnapshot()).toBeNull()
})

it('opens on a touch hold, swallows the click that ends it, and keeps later taps', () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const open = vi.fn(), tapped = vi.fn()
  const { getTriggerProps } = createContextMenuBindings(open, () => true)
  const view = render(<button {...getTriggerProps(target('held'))} onClick={tapped}>Held</button>)
  const button = view.getByRole('button', { name: 'Held' })
  fireEvent(button, pointer('pointerdown', { clientX: 8, clientY: 9 }))
  fireEvent(button, pointer('pointermove', { clientX: 11, clientY: 12 }))
  act(() => { vi.advanceTimersByTime(499) })
  expect(open).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(1) })
  expect(open).toHaveBeenCalledWith(target('held'), { x: 11, y: 12 })
  fireEvent.click(button)
  expect(tapped).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(400) })
  fireEvent.click(button)
  expect(tapped).toHaveBeenCalledOnce()
})

it('abandons a hold once the finger travels, leaving the tap intact', () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const open = vi.fn(), tapped = vi.fn()
  const { getTriggerProps } = createContextMenuBindings(open, () => true)
  const view = render(<button {...getTriggerProps(target('panned'))} onClick={tapped}>Panned</button>)
  const button = view.getByRole('button', { name: 'Panned' })
  fireEvent(button, pointer('pointerdown', { clientX: 5, clientY: 5 }))
  fireEvent(button, pointer('pointermove', { clientX: 40, clientY: 5 }))
  act(() => { vi.advanceTimersByTime(600) })
  expect(open).not.toHaveBeenCalled()
  fireEvent.click(button)
  expect(tapped).toHaveBeenCalledOnce()
})

it('keeps mouse presses and extra fingers out of the hold gesture', () => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const open = vi.fn()
  const { getTriggerProps } = createContextMenuBindings(open, () => true)
  const view = render(<button {...getTriggerProps(target('mouse'))}>Mouse</button>)
  const button = view.getByRole('button', { name: 'Mouse' })
  fireEvent(button, pointer('pointerdown', { pointerType: 'mouse' }))
  fireEvent(button, pointer('pointerdown', { isPrimary: false }))
  fireEvent(button, pointer('pointerdown', { button: 2 }))
  act(() => { vi.advanceTimersByTime(600) })
  expect(open).not.toHaveBeenCalled()
})
