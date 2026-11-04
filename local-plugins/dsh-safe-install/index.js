/**
 * dsh-safe-install — gate every plugin install behind a trial boot.
 *
 * The plugin manager's `installBundle()` is the single choke point used by the
 * Web UI's plugin page, the `plugin_manager` tool and the RPC surface. This
 * plugin wraps that method: before the real install runs, the candidate is
 * installed and booted in a throwaway DSH_HOME that mirrors this profile
 * (`dsh-safe-install.sh --test-only`). Only a green trial reaches the real
 * profile; a red one returns a normal failed `ChangeResult` with the trial log
 * as its diagnostic, so the UI shows the reason instead of a dead Web GUI.
 *
 * Installs started outside this process (`pnpm dsh plugin add` in a terminal)
 * never pass through here — run those through the same script, or install from
 * the UI / the plugin_manager tool to get the gate.
 *
 * @module dsh-safe-install
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'

/** Cordis plugin name. */
export const name = 'dsh-safe-install'

/** The plugin manager is the whole point; nothing works without it. */
export const inject = ['pluginManager']

const DEFAULTS = {
  /**
   * The trial runner. It ships beside this file, so the default is resolved from
   * this module's own location; DSH_SAFE_INSTALL_SCRIPT (or the `script` config
   * key) points it at another copy.
   */
  script: process.env.DSH_SAFE_INSTALL_SCRIPT ?? join(import.meta.dirname, 'dsh-safe-install.sh'),
  /** Hard ceiling for one trial (install + boot + probes). */
  timeoutMs: 240_000,
  /** Escape hatch: false runs installs untouched. */
  enabled: true,
}

/** Run the trial and report whether it went green. */
function runTrial(script, spec, timeoutMs) {
  return new Promise((resolve) => {
    let output = ''
    let child
    try {
      child = spawn(script, ['--test-only', spec], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, detail: `cannot run ${script}: ${error.message}` })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.()
    }, timeoutMs)
    const collect = (chunk) => {
      output += chunk.toString()
      if (output.length > 64_000) output = output.slice(-64_000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, detail: `cannot run ${script}: ${error.message}` })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const tail = output.trim().split('\n').slice(-40).join('\n')
      resolve({
        ok: code === 0,
        detail: code === 0 ? tail : `exit ${code ?? signal}\n${tail}`,
      })
    })
  })
}

/**
 * Wrap `pluginManager.installBundle` so no plugin reaches this profile before
 * it has booted elsewhere.
 * @param ctx - plugin context carrying the plugin manager.
 * @param config - see {@link DEFAULTS}.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  const manager = ctx.pluginManager
  if (typeof manager?.installBundle !== 'function') {
    ctx.logger.warn('[dsh-safe-install] pluginManager.installBundle is unavailable; installs are not gated')
    return
  }
  if (!settings.enabled) {
    ctx.logger.warn('[dsh-safe-install] disabled by config; installs are not gated')
    return
  }

  const original = manager.installBundle
  manager.installBundle = async function installBundleGated(spec, options) {
    // `skipSafeInstall` lets a caller (including this plugin's own tests) opt out.
    if (options?.skipSafeInstall === true) return original.call(this, spec, options)

    ctx.logger.info(`[dsh-safe-install] trial boot: ${spec}`)
    const started = Date.now()
    const trial = await runTrial(settings.script, spec, settings.timeoutMs)
    const seconds = ((Date.now() - started) / 1000).toFixed(1)

    if (!trial.ok) {
      ctx.logger.warn(`[dsh-safe-install] refused ${spec} after ${seconds}s:\n${trial.detail}`)
      return {
        changed: false,
        application: 'failed',
        stage: 'install',
        target: spec,
        error: {
          code: 'operation-error',
          diagnostic: `安全安装：\`${spec}\` 在隔离副本里试启动失败，已拒绝安装（未改动当前 profile）。\n\n${trial.detail}`,
        },
      }
    }

    ctx.logger.info(`[dsh-safe-install] trial passed for ${spec} (${seconds}s); installing`)
    return original.call(this, spec, options)
  }

  ctx.effect(() => () => {
    manager.installBundle = original
  }, 'dsh-safe-install: restore installBundle')
}
