/**
 * dsh-web-api-balance — local sidebar-row client (patch).
 *
 * LOCAL PATCH: sidebar balance row (LOCAL_PATCH_SIDEBAR_BALANCE_ROW)
 *
 * Replaces the package's composer chip with one row in `sidebar.footer.action`,
 * above the Restart dsh row, and drops the per-conversation cost column. The
 * Host half (credentials, caching, `/plugins/dsh-web-api-balance/balance`) is
 * unchanged; this file only renders the summary.
 */
;(() => {
  const BASE = '/plugins/dsh-web-api-balance'
  const LEDGER = '/plugins/dsh-session-tariff/session-cost'
  const CACHE_KEY = 'dsh-web-api-balance:sidebar-last'
  const POLL_MS = 300000

  const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' }
  const money = (value, currency) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return '--'
    const symbol = CURRENCY_SYMBOL[currency] || (currency ? `${currency} ` : '')
    return `${symbol}${n.toFixed(2)}`
  }


  // ---- session cost inside the official Token usage dialog -----------------
  // Official CNY list prices per 1M tokens (peak tariff). Kept local so the
  // dialog can price the same four buckets the Host already reports.
  const PRICING = {
    'deepseek-flash': {
      off: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    },
    'deepseek-v4-pro': {
      off: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    },
  }
  const PRICING_ALIASES = {
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  }

  const countOf = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

  function isPeakAt(instant) {
    // Beijing time, independent of the browser zone: shift, then read UTC getters.
    const beijing = new Date(instant.getTime() + 8 * 60 * 60 * 1000)
    const day = beijing.getUTCDay()
    if (day === 0 || day === 6) return false
    const hour = beijing.getUTCHours()
    return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
  }

  function priceTableOf(model) {
    if (typeof model !== 'string' || model === '') return undefined
    const slash = model.lastIndexOf('/')
    const bare = slash === -1 ? model : model.slice(slash + 1)
    const id = PRICING[bare] === undefined ? model : bare
    const alias = PRICING_ALIASES[id]
    return PRICING[id] ?? (alias === undefined ? undefined : PRICING[alias])
  }

  function tariffAt(instant, selection) {
    const table = priceTableOf(selection?.next?.model ?? selection?.lastUsed?.model)
    if (table === undefined) return undefined
    return isPeakAt(instant) ? table.peak : table.off
  }

  function formatCny(value) {
    const n = Number(value)
    if (!Number.isFinite(n)) return '--'
    const digits = n > 0 && n < 0.01 ? 3 : 2
    try {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency', currency: 'CNY',
        minimumFractionDigits: digits, maximumFractionDigits: digits,
      }).format(n)
    } catch {
      return `¥${n.toFixed(digits)}`
    }
  }

  function costOfBuckets(hit, miss, output, price) {
    return (hit / 1e6) * price.cacheHit + (miss / 1e6) * price.cacheMiss + (output / 1e6) * price.output
  }

  function sessionCost(usage, selection, nodes, ledger) {
    if (usage === null || typeof usage !== 'object') return null
    const whole = {
      hit: countOf(usage.cacheReadTokens),
      miss: countOf(usage.uncachedInputTokens) + countOf(usage.cacheWriteTokens),
      output: countOf(usage.outputTokens),
    }
    const wholeTotal = whole.hit + whole.miss + whole.output
    if (wholeTotal === 0) return null

    const current = tariffAt(new Date(), selection)

    // Recorded peak/off-peak buckets from dsh-session-tariff. They are exact
    // for every assistant message seen since that plugin started.
    let ledgerHit = 0
    let ledgerMiss = 0
    let ledgerOutput = 0
    let ledgerCost = 0
    let ledgerPriced = true
    if (ledger !== null && typeof ledger === 'object' && ledger.recorded === true
      && ledger.models !== null && typeof ledger.models === 'object') {
      for (const [model, buckets] of Object.entries(ledger.models)) {
        const table = priceTableOf(model)
        for (const tariff of ['peak', 'off']) {
          const bucket = buckets?.[tariff]
          const hit = countOf(bucket?.hit)
          const miss = countOf(bucket?.miss)
          const output = countOf(bucket?.out)
          if (hit + miss + output === 0) continue
          ledgerHit += hit
          ledgerMiss += miss
          ledgerOutput += output
          if (table === undefined) {
            ledgerPriced = false
            continue
          }
          ledgerCost += costOfBuckets(hit, miss, output, table[tariff])
        }
      }
    }
    const ledgerTokens = ledgerHit + ledgerMiss + ledgerOutput

    if (ledgerTokens > 0 && ledgerPriced) {
      const missingHit = Math.max(0, whole.hit - ledgerHit)
      const missingMiss = Math.max(0, whole.miss - ledgerMiss)
      const missingOutput = Math.max(0, whole.output - ledgerOutput)
      const missingCost = current === undefined
        ? undefined
        : costOfBuckets(missingHit, missingMiss, missingOutput, current)
      const priced = current !== undefined
      const totalCny = priced ? ledgerCost + (missingCost ?? 0) : undefined
      const exact = priced && missingHit + missingMiss + missingOutput === 0
      return {
        totalCny,
        priced,
        covered: Math.min(1, ledgerTokens / wholeTotal),
        exact,
        source: 'ledger',
      }
    }

    // No ledger (or an unknown model): infer from the loaded assistant steps,
    // pricing the remainder outside the window at the current tariff.
    let covered = 0
    let stepCost = 0
    let nodeHit = 0
    let nodeMiss = 0
    let nodeOutput = 0
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        if (node === null || typeof node !== 'object' || node.kind !== 'assistant') continue
        if (node.usage === null || typeof node.usage !== 'object') continue
        const u = node.usage
        const hit = countOf(u.cacheReadTokens)
        const miss = countOf(u.inputTokens ?? u.uncachedInputTokens) + countOf(u.cacheWriteTokens)
        const output = countOf(u.outputTokens)
        if (hit + miss + output === 0) continue
        const at = new Date(node.timing?.stepStartTime ?? node.time ?? Date.now())
        const price = tariffAt(at, selection)
        if (price === undefined) continue
        nodeHit += hit
        nodeMiss += miss
        nodeOutput += output
        covered += hit + miss + output
        stepCost += costOfBuckets(hit, miss, output, price)
      }
    }

    const missingHit = Math.max(0, whole.hit - nodeHit)
    const missingMiss = Math.max(0, whole.miss - nodeMiss)
    const missingOutput = Math.max(0, whole.output - nodeOutput)
    const priced = current !== undefined
    const totalCny = priced
      ? stepCost + costOfBuckets(missingHit, missingMiss, missingOutput, current)
      : undefined
    return {
      totalCny,
      priced,
      covered: Math.min(1, covered / wholeTotal),
      exact: false,
      source: 'inferred',
    }
  }

  // The hidden dock entry publishes the current estimate; the DOM observer
  // appends one 费用 row to the official dialog whenever it is open.
  let costSnapshot = null
  const costListeners = new Set()
  function publishCost(next) {
    costSnapshot = next
    for (const listener of costListeners) listener()
  }
  function subscribeCost(listener) {
    costListeners.add(listener)
    return () => { costListeners.delete(listener) }
  }

  const COST_ROW = 'data-dsh-usage-cost'

  function syncCostRows() {
    const zh = /^zh\b/i.test(document.documentElement.lang || navigator.language || '')
    const estimated = costSnapshot !== null && !costSnapshot.exact
    const label = zh ? `费用${estimated ? '（推算）' : ''}` : `Cost${estimated ? ' (estimated)' : ''}`
    for (const dl of document.querySelectorAll('[data-session-stats-usage]')) {
      let wrap = dl.querySelector(`[${COST_ROW}]`)
      if (wrap === null) {
        wrap = document.createElement('div')
        wrap.setAttribute(COST_ROW, '')
        wrap.style.display = 'contents'
        const rule = document.createElement('div')
        rule.style.cssText = 'grid-column:1/-1;border-top:.5px solid var(--dsw-alias-border-l2);margin:6px 0 0'
        const dt = document.createElement('dt')
        dt.textContent = label
        const dd = document.createElement('dd')
        wrap.append(rule, dt, dd)
        dl.append(wrap)
      }
      const dt = wrap.querySelector('dt')
      const dd = wrap.querySelector('dd')
      if (dt === null || dd === null) continue
      if (dt.textContent !== label) dt.textContent = label
      const text = costSnapshot === null
        ? '—'
        : costSnapshot.priced
          ? formatCny(costSnapshot.totalCny)
          : (zh ? '未收录该模型价格' : 'Price not listed')
      if (dd.textContent !== text) dd.textContent = text
      const covered = Math.round((costSnapshot?.covered ?? 0) * 100)
      const title = costSnapshot === null || !costSnapshot.priced
        ? ''
        : costSnapshot.exact
          ? (zh ? '按插件记录的峰谷 token 用量计算' : 'Computed from recorded peak/off-peak usage')
          : (zh
            ? `推算：逐请求时间覆盖 ${covered}%，其余按当前时段价；不含节假日`
            : `Estimated: ${covered}% of tokens have a per-request clock; the rest uses the current tariff; holidays excluded`)
      if ((dd.getAttribute('title') || '') !== title) {
        if (title) dd.setAttribute('title', title)
        else dd.removeAttribute('title')
      }
    }
  }

  function installCostObserver() {
    let scheduled = false
    const schedule = () => {
      if (scheduled) return
      scheduled = true
      window.requestAnimationFrame(() => {
        scheduled = false
        syncCostRows()
      })
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    const unsubscribe = subscribeCost(schedule)
    schedule()
    return () => {
      observer.disconnect()
      unsubscribe()
      for (const row of document.querySelectorAll(`[${COST_ROW}]`)) row.remove()
    }
  }

  const readCache = () => {
    try {
      const raw = window.localStorage.getItem(CACHE_KEY)
      if (!raw) return { phase: 'loading' }
      const data = JSON.parse(raw)
      if (data && data.ok) return { phase: 'ready', data }
    } catch {
      /* ignore a corrupt cache */
    }
    return { phase: 'loading' }
  }

  const writeCache = (data) => {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(data))
    } catch {
      /* storage may be unavailable */
    }
  }

  const LINE = {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 16,
    padding: '2px 0',
    color: 'var(--dsw-alias-label-secondary)',
  }
  const VALUE = { color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' }
  const MUTED = { color: 'var(--dsw-alias-label-secondary)', fontSize: 11, lineHeight: '16px' }
  const ICON_BUTTON = {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    font: 'inherit',
    fontSize: 13,
    cursor: 'pointer',
    padding: 0,
  }


  function UsageCostObserver(props) {
    const React = props.__react
    const usage = props.useProjection('tokenUsage')
    const selection = props.useProjection('modelSelection')
    const useChat = props.useChat
    const nodes = typeof useChat === 'function' ? useChat(s => s.legacy.nodes) : undefined
    const sessionId = props.sessionId
    const [ledger, setLedger] = React.useState(null)

    React.useEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      let alive = true
      const load = () => {
        fetch(`${LEDGER}?sessionId=${encodeURIComponent(sessionId)}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        })
          .then(response => (response.ok ? response.json() : null))
          .then(body => { if (alive) setLedger(body) })
          .catch(() => {})
      }
      const timer = window.setTimeout(load, 400)
      const interval = window.setInterval(load, 30000)
      return () => {
        alive = false
        window.clearTimeout(timer)
        window.clearInterval(interval)
      }
    }, [sessionId, usage])

    React.useEffect(() => {
      publishCost(sessionCost(usage, selection, nodes, ledger))
    }, [usage, selection, nodes, ledger])
    return null
  }

  function BalanceRow(props) {
    const React = props.__react
    const ReactDOM = props.__reactDom
    const wide = props.wide !== false
    const [snap, setSnap] = React.useState(readCache)
    const [open, setOpen] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const mounted = React.useRef(true)
    const closeTimer = React.useRef(0)
    const triggerRef = React.useRef(null)
    const panelRef = React.useRef(null)
    const [pos, setPos] = React.useState(null)

    React.useLayoutEffect(() => {
      if (wide || !open) {
        setPos(null)
        return
      }
      const trigger = triggerRef.current
      if (trigger === null) return
      const rect = trigger.getBoundingClientRect()
      setPos({
        position: 'fixed',
        left: Math.round(rect.right),
        bottom: Math.round(Math.max(12, window.innerHeight - rect.bottom)),
        top: 'auto',
        right: 'auto',
      })
    }, [wide, open])

    React.useEffect(() => {
      if (!open) return undefined
      const onPointerDown = event => {
        const target = event.target
        const inRow = triggerRef.current !== null && triggerRef.current.contains(target)
        const inPanel = panelRef.current !== null && panelRef.current.contains(target)
        if (!inRow && !inPanel) setOpen(false)
      }
      document.addEventListener('pointerdown', onPointerDown, true)
      return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
    }, [open])

    const openNow = React.useCallback(() => {
      window.clearTimeout(closeTimer.current)
      setOpen(true)
    }, [])
    const closeSoon = React.useCallback(() => {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = window.setTimeout(() => setOpen(false), 200)
    }, [])
    React.useEffect(() => () => { window.clearTimeout(closeTimer.current) }, [])

    const refresh = React.useCallback(async (force) => {
      if (force) setBusy(true)
      try {
        const response = await fetch(`${BASE}/balance${force ? '?refresh=1' : ''}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const body = await response.json()
        if (!mounted.current) return
        if (body && body.ok) {
          writeCache(body)
          setSnap({ phase: 'ready', data: body })
        } else {
          setSnap(previous => ({
            phase: 'error',
            error: (body && (body.message || body.reason)) || '余额不可用',
            data: previous.data,
          }))
        }
      } catch (error) {
        if (mounted.current) {
          setSnap(previous => ({
            phase: 'error',
            error: error && error.message ? error.message : String(error),
            data: previous.data,
          }))
        }
      } finally {
        if (mounted.current && force) setBusy(false)
      }
    }, [])

    React.useEffect(() => {
      mounted.current = true
      refresh(false)
      const timer = window.setInterval(() => {
        if (document.visibilityState !== 'hidden') refresh(false)
      }, POLL_MS)
      const onVisible = () => {
        if (document.visibilityState === 'visible') refresh(false)
      }
      document.addEventListener('visibilitychange', onVisible)
      return () => {
        mounted.current = false
        window.clearInterval(timer)
        document.removeEventListener('visibilitychange', onVisible)
      }
    }, [refresh])

    const data = snap.data
    const failed = snap.phase === 'error'
    const amount = data ? money(data.total, data.currency) : failed ? '--' : '…'
    const exhausted = Boolean(data && data.available === false)
    const color = failed || exhausted
      ? 'var(--dsw-alias-state-error-primary)'
      : snap.phase === 'loading' && !data
        ? 'var(--dsw-alias-state-idle-primary)'
        : 'var(--dsw-alias-state-success-primary)'
    const title = data ? `DeepSeek API 余额 ${amount}` : 'DeepSeek API 余额'

    const rowStyle = wide
      ? {
          height: 32,
          width: '100%',
          padding: '0 10px',
          border: 'none',
          borderRadius: 8,
          background: 'transparent',
          font: 'inherit',
          fontSize: 14,
          color: 'var(--dsw-alias-label-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          cursor: 'pointer',
        }
      : {
          height: 32,
          width: 32,
          padding: 0,
          border: 'none',
          borderRadius: 8,
          background: 'transparent',
          font: 'inherit',
          color: 'var(--dsw-alias-label-secondary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          margin: '0 auto',
        }

    const line = (label, value, strong) => React.createElement(
      'div',
      { style: LINE },
      React.createElement('span', null, label),
      React.createElement('span', { style: strong ? { ...VALUE, fontWeight: 500 } : VALUE }, value),
    )

    const panel = open
      ? React.createElement(
          'div',
          {
            ref: panelRef,
            'data-dsh-balance-panel': '',
            style: wide
              ? {
                  position: 'absolute',
                  left: 0,
                  bottom: 'calc(100% + 8px)',
                  zIndex: 1400,
                  boxSizing: 'border-box',
                  minWidth: 208,
                  maxWidth: 'calc(100vw - 24px)',
                  padding: '10px 12px',
                  borderRadius: 'var(--dsw-radius-md, 8px)',
                  background: 'var(--dsw-alias-bg-overlay)',
                  boxShadow: 'var(--dsw-elevation-panel)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  lineHeight: '18px',
                  textAlign: 'left',
                }
              : {
                  position: 'fixed',
                  left: 0,
                  bottom: 0,
                  visibility: pos === null ? 'hidden' : 'visible',
                  ...(pos ?? {}),
                  zIndex: 1400,
                  boxSizing: 'border-box',
                  minWidth: 208,
                  maxWidth: 'min(320px, calc(100vw - 24px))',
                  padding: '10px 12px',
                  borderRadius: 'var(--dsw-radius-md, 8px)',
                  background: 'var(--dsw-alias-bg-overlay)',
                  boxShadow: 'var(--dsw-elevation-panel)',
                  color: 'var(--dsw-alias-label-primary)',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  lineHeight: '18px',
                  textAlign: 'left',
                },
          },
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 } },
            React.createElement('span', { style: { fontWeight: 500 } }, 'DeepSeek API 余额'),
            React.createElement('button', {
              type: 'button',
              title: '刷新',
              'aria-label': '刷新',
              disabled: busy,
              onClick: () => refresh(true),
              style: { ...ICON_BUTTON, opacity: busy ? 0.4 : 1 },
            }, busy ? '…' : '↻'),
          ),
          failed
            ? React.createElement(
                'div',
                null,
                React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-word' } }, snap.error || '余额不可用'),
                data ? React.createElement('div', { style: { ...MUTED, marginTop: 6 } }, `上次成功：${money(data.total, data.currency)} · ${new Date(data.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}`) : null,
              )
            : React.createElement(
                'div',
                null,
                line('总余额', amount, true),
                line('充值余额', data ? money(data.toppedUp, data.currency) : '--'),
                line('赠送余额', data ? money(data.granted, data.currency) : '--'),
                React.createElement('div', { style: { margin: '8px 0 6px', borderTop: '.5px solid var(--dsw-alias-border-l1)' } }),
                React.createElement('div', { style: MUTED },
                  data ? `更新 ${new Date(data.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })} · ${data.source === 'account' ? 'DeepSeek 账号' : 'API Key'}` : '正在读取…',
                ),
                exhausted ? React.createElement('div', { style: { ...MUTED, color: 'var(--dsw-alias-state-error-primary)', marginTop: 4 } }, '余额已用尽') : null,
              ),
          React.createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 8 } },
            React.createElement('a', {
              href: (data && data.topUpUrl) || 'https://platform.deepseek.com/top_up',
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { color: 'var(--dsw-alias-brand-primary)', textDecoration: 'none', fontSize: 12 },
            }, '去充值'),
            failed
              ? React.createElement('button', { type: 'button', onClick: () => refresh(true), style: ICON_BUTTON }, '重试')
              : null,
          ),
        )
      : null
    const renderedPanel = panel === null || wide ? panel : ReactDOM.createPortal(panel, document.body)

    return React.createElement(
      'div',
      {
        'data-dsh-balance-row': '',
        style: { position: 'relative', width: wide ? '100%' : 32, flex: 'none' },
      },
      React.createElement(
        'button',
        {
          type: 'button',
          ref: triggerRef,
          title,
          'aria-label': title,
          onClick: () => {
            if (open) {
              setOpen(false)
              return
            }
            setOpen(true)
            refresh(true)
          },
          onMouseEnter: event => { event.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05))' },
          onMouseLeave: event => { event.currentTarget.style.background = 'transparent' },
          style: rowStyle,
        },
        React.createElement('span', {
          'aria-hidden': 'true',
          style: { display: 'inline-flex', flex: 'none', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, color },
        }, React.createElement('svg', {
          width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
          strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        },
        React.createElement('path', { d: 'M21 12V7H5a2 2 0 0 1 0-4h14v4' }),
        React.createElement('path', { d: 'M3 5v14a2 2 0 0 0 2 2h16v-5' }),
        React.createElement('path', { d: 'M18 12a2 2 0 0 0 0 4h4v-4Z' }),
        )),
        wide
          ? React.createElement('span', {
              style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', fontVariantNumeric: 'tabular-nums', color: failed || exhausted ? 'var(--dsw-alias-state-error-primary)' : 'inherit' },
            }, amount)
          : null,
      ),
      renderedPanel,
    )
  }

  window.__ModuleLoader__.load({
    id: 'dsh-web-api-balance',
    factory: (require) => {
      const React = require('react')
      const ReactDOM = require('react-dom')
      const inject = ['slots']

      function apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-dsh-balance-style', '')
          style.textContent = 'div:has(> [data-slot="sidebar.footer.action"]){flex-direction:column}'
          document.head.appendChild(style)
          return () => { style.remove() }
        }, 'dsh-web-api-balance: footer stack')

        ctx.slots.inject('sidebar.footer.action', function* () {
          yield ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'api-balance',
            order: 5,
          }, (props) => React.createElement(BalanceRow, { ...props, __react: React, __reactDom: ReactDOM }))
        })

        ctx.slots.inject('conversation.composer.dock', function* () {
          yield ctx.slots.register({
            name: 'conversation.composer.dock',
            id: 'usage-cost',
            order: 50,
          }, (props) => React.createElement(UsageCostObserver, { ...props, __react: React }))
        })

        ctx.effect(() => installCostObserver(), 'dsh-web-api-balance: usage cost row')
      }

      return { apply, inject, name: 'dsh-web-api-balance' }
    },
  })
})()
