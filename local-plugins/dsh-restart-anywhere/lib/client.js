// dsh-restart-anywhere — browser half: two rows in the sidebar's More menu
// (the panel list's 更多), not as their own footer rows.
//
//   ↻ 立即重启 dsh      — immediate: running sessions are interrupted and
//                          resumed after the restart (continue_prompt wakes the
//                          caller; other sessions get an interruption notice).
//   ⏰ 空闲时重启 dsh    — safe: waits until every running turn has finished,
//                          then restarts; cancels instead of cutting work.
//
// Every string is localized through this plugin's own locale namespace, so the
// rows, confirms, toasts, and failure messages follow the app language.
window.__ModuleLoader__.load({ id: 'dsh-restart-anywhere', factory: (require) => {
  const React = require('react')
  const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
  const { MenuItemButton, IconRefreshOutlineRegular, IconAlarmClockOutlineRegular } = primitives
  const h = React.createElement
  const { useState, useEffect, useCallback } = React

  const ROUTE = 'api/dsh-restart' // relative: works under a path prefix too
  /** Locale namespace owned by this plugin; the registration's translate seat. */
  const NS = 'dsh-restart-anywhere'
  /** Seconds a safe restart waits for running turns before cancelling. */
  const WAIT_SECONDS = 120

  /** Baseline dictionaries: the locale service requires zh and en. */
  const LOCALES = {
    zh: {
      'restart.now': '立即重启 dsh',
      'restart.idle': '空闲时重启 dsh',
      'confirm.now': '重启 dsh（{via}）？\n正在运行的会话会被打断，重启后会自动恢复。',
      'confirm.idle': '等所有会话把当前这一轮跑完再重启 dsh？\n不会打断任何会话；最多等 {seconds} 秒，超时就取消这次重启。',
      'via.systemd': 'systemd：{unit}',
      'via.inplace': '原地重启',
      'starting.now': 'dsh 正在重启…',
      'starting.idle': '等 {count} 个会话收尾后重启…',
      'starting.idle.none': '会话都空了，正在重启…',
      'cancelled': '安全重启已取消：还有会话在忙。没有打断任何会话。',
      'noReturn': 'dsh 在 5 分钟内没有回来，刷新页面看看。',
      'failed': '重启失败：{message}',
      'unsupported': '当前环境不支持重启 dsh。',
    },
    en: {
      'restart.now': 'Restart dsh now',
      'restart.idle': 'Restart when idle',
      'confirm.now': 'Restart dsh ({via})?\nRunning sessions will be interrupted, then resumed automatically.',
      'confirm.idle': 'Restart dsh after every session has finished the turn it is running?\n'
        + 'Nothing is cut off. Waits up to {seconds}s, then cancels instead of interrupting anyone.',
      'via.systemd': 'systemd: {unit}',
      'via.inplace': 'in place',
      'starting.now': 'Restarting dsh…',
      'starting.idle': 'Waiting for {count} session(s) to finish…',
      'starting.idle.none': 'All sessions are idle; restarting…',
      'cancelled': 'The safe restart was cancelled: sessions were still working. Nothing was interrupted.',
      'noReturn': 'dsh did not come back within 5 minutes; try reloading the page.',
      'failed': 'Restart failed: {message}',
      'unsupported': 'Restart is not supported in this environment.',
    },
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const info = () => fetch(ROUTE, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null), () => null)

  /** One shared status line under the sidebar, replaced in place while a restart runs. */
  let toastEl = null
  let toastTimer = null
  function toast(text, holdMs = 4000) {
    if (typeof document === 'undefined') return
    if (toastEl === null) {
      toastEl = document.createElement('div')
      toastEl.setAttribute('role', 'status')
      toastEl.setAttribute('aria-live', 'polite')
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;'
        + 'padding:8px 14px;border-radius:8px;background:var(--dsw-alias-bg-elevated,#1f2329);'
        + 'color:var(--dsw-alias-label-primary,#fff);font-size:13px;line-height:20px;'
        + 'box-shadow:0 6px 24px rgba(0,0,0,.18);pointer-events:none;max-width:72vw'
      document.body.appendChild(toastEl)
    }
    toastEl.textContent = text
    toastEl.style.display = 'block'
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = holdMs > 0 ? setTimeout(() => { if (toastEl) toastEl.style.display = 'none' }, holdMs) : null
  }

  /** True once a server with a different boot id answers. `onTick` sees every poll. */
  async function waitForNewBoot(oldBoot, onTick) {
    for (let i = 0; i < 300; i++) {
      await sleep(1000)
      const b = await info()
      if (b && b.boot && b.boot !== oldBoot) return true
      if (onTick) onTick(b)
    }
    return false
  }

  /** One restart at a time across both rows. */
  let running = false

  function RestartMenu({ onDismiss, t }) {
    const [how, setHow] = useState(null)
    useEffect(() => { info().then(setHow) }, [])
    // A desktop app owns its own lifecycle; no rows there.
    if (how !== null && !how.mode) return null

    const begin = useCallback(async (idle) => {
      onDismiss()
      if (running) return
      const current = how ?? await info()
      if (!current || !current.mode) { toast(t('unsupported'), 5000); return }
      const via = current.mode === 'systemd' ? t('via.systemd', { unit: current.unit }) : t('via.inplace')
      const confirmText = idle ? t('confirm.idle', { seconds: WAIT_SECONDS }) : t('confirm.now', { via })
      if (!window.confirm(confirmText)) return
      running = true
      try {
        const url = idle ? ROUTE + '?when=idle&wait=' + WAIT_SECONDS : ROUTE
        const res = await fetch(url, { method: 'POST' })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status)
        if (!idle) {
          toast(t('starting.now'), 0)
          if (await waitForNewBoot(current.boot)) return window.location.reload()
          toast(t('noReturn'), 8000)
          return
        }
        toast(t('starting.idle', { count: body.waiting || 0 }), 0)
        let cancelled = false
        const arrived = await waitForNewBoot(current.boot, (b) => {
          if (b && b.draining) {
            const count = b.draining.waiting || 0
            toast(count > 0 ? t('starting.idle', { count }) : t('starting.idle.none'), 0)
          } else if (b && !b.draining && b.boot === current.boot) {
            cancelled = true
          }
        })
        if (arrived) return window.location.reload()
        toast(cancelled ? t('cancelled') : t('noReturn'), 8000)
      } catch (err) {
        toast(t('failed', { message: err && err.message ? err.message : String(err) }), 8000)
      } finally {
        running = false
      }
    }, [how, onDismiss, t])

    return h(React.Fragment, null,
      h(MenuItemButton, {
        icon: h(IconRefreshOutlineRegular, { size: 16 }),
        separatorBefore: true,
        onSelect: () => { void begin(false) },
      }, t('restart.now')),
      h(MenuItemButton, {
        icon: h(IconAlarmClockOutlineRegular, { size: 16 }),
        onSelect: () => { void begin(true) },
      }, t('restart.idle')))
  }

  return {
    inject: ['slots', 'locale'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, LOCALES), 'dsh-restart-anywhere: locales')
      ctx.effect(() => ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({
        name: 'sidebar.panellist.actions', id: 'dsh-restart-anywhere', order: 50, locale: NS,
      }, RestartMenu)), 'dsh-restart-anywhere: sidebar More rows')
    },
  }
} })
