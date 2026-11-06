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
  const CACHE_KEY = 'dsh-web-api-balance:sidebar-last'
  const POLL_MS = 300000

  const CURRENCY_SYMBOL = { CNY: '¥', USD: '$' }
  const money = (value, currency) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return '--'
    const symbol = CURRENCY_SYMBOL[currency] || (currency ? `${currency} ` : '')
    return `${symbol}${n.toFixed(2)}`
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

  function BalanceRow(props) {
    const React = props.__react
    const wide = props.wide !== false
    const [snap, setSnap] = React.useState(readCache)
    const [open, setOpen] = React.useState(false)
    const [busy, setBusy] = React.useState(false)
    const mounted = React.useRef(true)
    const closeTimer = React.useRef(0)

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

    const panel = wide && open
      ? React.createElement(
          'div',
          {
            style: {
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
            },
            onMouseEnter: openNow,
            onMouseLeave: closeSoon,
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

    return React.createElement(
      'div',
      {
        'data-dsh-balance-row': '',
        style: { position: 'relative', width: wide ? '100%' : 32, flex: 'none' },
        onMouseEnter: openNow,
        onMouseLeave: closeSoon,
      },
      React.createElement(
        'button',
        {
          type: 'button',
          title,
          'aria-label': title,
          onClick: () => refresh(true),
          onFocus: openNow,
          onBlur: event => {
            if (!event.currentTarget.parentElement.contains(event.relatedTarget)) setOpen(false)
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
      wide && open
        ? React.createElement('div', {
            style: { position: 'absolute', left: 0, right: 0, bottom: '100%', height: 10, zIndex: 1399 },
            onMouseEnter: openNow,
            onMouseLeave: closeSoon,
          })
        : null,
      panel,
    )
  }

  window.__ModuleLoader__.load({
    id: 'dsh-web-api-balance',
    factory: (require) => {
      const React = require('react')
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
          }, (props) => React.createElement(BalanceRow, { ...props, __react: React }))
        })
      }

      return { apply, inject, name: 'dsh-web-api-balance' }
    },
  })
})()
