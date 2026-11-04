/** DOM gesture bindings owned by one menu plugin instance. */
import type { SyntheticEvent } from 'react'
import type { ContextMenuTriggerProps, MenuPoint, ContextMenuTarget } from './types.ts'

/** A press must last this long before it reads as a menu gesture rather than a tap. */
const LONG_PRESS_MS = 500
/** Travel past this many CSS pixels is a pan or a selection, so the hold is abandoned. */
const LONG_PRESS_SLOP_PX = 10
/** How long the click ending a long press may still arrive; a cancelled gesture must not eat the next tap. */
const SWALLOW_CLICK_MS = 400

/** One pending press, owned by the element it started on so an unrelated render cannot orphan the timer. */
interface Hold {
  readonly timer: ReturnType<typeof setTimeout>
  readonly origin: MenuPoint
  point: MenuPoint
}

const holds = new WeakMap<HTMLElement, Hold>()

/**
 * Abandon a pending hold.
 * @param element - Element the press started on.
 */
function releaseHold(element: HTMLElement): void {
  const hold = holds.get(element)
  if (hold === undefined) return
  clearTimeout(hold.timer)
  holds.delete(element)
}

/**
 * Stop the click a completed hold delivers, so the element's own tap action does not run behind the menu.
 * @param element - Element whose click should be dropped once.
 */
function swallowTrailingClick(element: HTMLElement): void {
  const swallow = (event: Event): void => {
    event.preventDefault()
    event.stopPropagation()
  }
  element.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => element.removeEventListener('click', swallow, { capture: true }), SWALLOW_CLICK_MS)
}

/**
 * Create stable bindings for the plugin's injected hook.
 * @param open - Open against the supplied captured target and viewport position.
 * @param active - Whether the plugin still owns its service.
 * @returns Ordinary trigger-prop factory; no React subscription or context is created.
 */
export function createContextMenuBindings<Target extends object = ContextMenuTarget>(
  open: (target: Target, point: MenuPoint) => void, active: () => boolean,
): { getTriggerProps: (target: Target | (() => Target) | undefined, handlers?: ContextMenuTriggerProps) => ContextMenuTriggerProps } {
  return {
    getTriggerProps(target, handlers = {}) {
      if (target === undefined) return handlers
      const show = (event: SyntheticEvent<HTMLElement>, x: number, y: number): void => {
        if (event.defaultPrevented || !active()) return
        const captured = typeof target === 'function' ? target() : target
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        open(captured, { x, y })
      }
      const fire = (element: HTMLElement, point: MenuPoint): void => {
        releaseHold(element)
        if (!active()) return
        const captured = typeof target === 'function' ? target() : target
        element.focus({ preventScroll: true })
        open(captured, point)
        swallowTrailingClick(element)
      }
      return {
        ...handlers,
        tabIndex: handlers.tabIndex ?? 0,
        onContextMenu(event) {
          handlers.onContextMenu?.(event)
          // Android reports its own long press here; one menu per gesture is enough.
          releaseHold(event.currentTarget)
          const rect = event.clientX === 0 && event.clientY === 0 ? event.currentTarget.getBoundingClientRect() : undefined
          show(event, rect?.left ?? event.clientX, rect?.bottom ?? event.clientY)
        },
        onKeyDown(event) {
          handlers.onKeyDown?.(event)
          if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey
            || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return
          const rect = event.currentTarget.getBoundingClientRect()
          show(event, rect.left, rect.bottom)
        },
        onPointerDown(event) {
          handlers.onPointerDown?.(event)
          const element = event.currentTarget
          releaseHold(element)
          // A mouse has a right button already, and a secondary press or an extra finger is a different gesture.
          if (event.button > 0 || event.pointerType === 'mouse' || event.isPrimary === false
            || event.defaultPrevented || !active()) return
          const point = { x: event.clientX, y: event.clientY }
          holds.set(element, { origin: point, point, timer: setTimeout(() => {
            fire(element, holds.get(element)?.point ?? point)
          }, LONG_PRESS_MS) })
        },
        onPointerMove(event) {
          handlers.onPointerMove?.(event)
          const element = event.currentTarget
          const hold = holds.get(element)
          if (hold === undefined) return
          if (Math.abs(event.clientX - hold.origin.x) > LONG_PRESS_SLOP_PX
            || Math.abs(event.clientY - hold.origin.y) > LONG_PRESS_SLOP_PX) {
            releaseHold(element)
            return
          }
          hold.point = { x: event.clientX, y: event.clientY }
        },
        onPointerUp(event) {
          handlers.onPointerUp?.(event)
          releaseHold(event.currentTarget)
        },
        onPointerCancel(event) {
          handlers.onPointerCancel?.(event)
          releaseHold(event.currentTarget)
        },
        onPointerLeave(event) {
          handlers.onPointerLeave?.(event)
          releaseHold(event.currentTarget)
        },
      }
    },
  }
}
