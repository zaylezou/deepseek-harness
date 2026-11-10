// Lockdown patch generation tests. Pure strings; no boot, no browser.
//
//   node --test test/
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLockdownPatch } from '../src/instance.js'

const WORKSPACE = '/home/user/project/e2e_instance/e2e-demo'

test('the lockdown patch pins policy, approval, permission and the web bind', () => {
  const patch = buildLockdownPatch(WORKSPACE)
  assert.match(patch, /- id: sandbox-policy\n  name: '@deepseek-ai\/dsh-sandbox-policy'\n  config:\n    mode: workspace-write\n    workspaceRoot: "\/home\/user\/project\/e2e_instance\/e2e-demo"/)
  assert.match(patch, /- id: approval\n  name: '@deepseek-ai\/dsh-user-approval'\n  config:\n    policy: never/)
  assert.match(patch, /- id: permission\n  name: '@deepseek-ai\/dsh-permission-presets'/)
  assert.match(patch, /      locked:\n        sandbox: workspace-write\n        approval: never/)
  assert.match(patch, /    defaultPreset: locked/)
  assert.match(patch, /- id: webserver\n  name: '@deepseek-ai\/dsh-host-webserver'\n  config:\n    host: "127\.0\.0\.1"/)
  assert.doesNotMatch(patch, /danger-full-access/)
})

test('host-side management rows are disabled without breaking the standard preset', () => {
  const patch = buildLockdownPatch(WORKSPACE, { host: '10.0.0.7' })
  for (const id of ['ui-plugin-manager', 'ui-open-in-app', 'mcp-manager', 'open-in-app', 'terminal-controller', 'ui-sidebar-terminal', 'dsh-restart-anywhere']) {
    assert.match(patch, new RegExp(`- id: ${id}\\n  disabled: true`))
  }
  // The plugin-manager service itself stays mounted: tool-plugin-manager in the
  // standard preset injects it, and a missing service fails every session create.
  assert.doesNotMatch(patch, /- id: plugin-manager\n  disabled: true/)
  assert.match(patch, /- id: webserver[\s\S]*?host: "10\.0\.0\.7"/)
})

test('the lockdown plugin row is forced to always with the instance root and deny list', () => {
  const patch = buildLockdownPatch(WORKSPACE, { denyTools: ['plugin_manager', 'custom_tool'] })
  assert.match(patch, /- id: dsh-e2e-lockdown\n  name: 'dsh-e2e-lockdown'\n  config:\n    mode: always\n    sandboxMode: workspace-write/)
  assert.match(patch, /    workspaceRoot: "\/home\/user\/project\/e2e_instance\/e2e-demo"/)
  assert.match(patch, /    denyTools:\n      - "plugin_manager"\n      - "custom_tool"/)
  assert.doesNotMatch(patch, /ntfy_send/)
})

test('the default deny list covers the local side-effect and nesting tools', () => {
  const patch = buildLockdownPatch(WORKSPACE)
  for (const name of ['plugin_manager', 'e2e', 'e2e_instance', 'ntfy_send', 'ntfy_send_file', 'dsh_restart', 'dsh_safe_restart']) {
    assert.match(patch, new RegExp(`      - "${name}"`))
  }
})

test('the patch quotes paths that YAML would otherwise misread', () => {
  const patch = buildLockdownPatch('/tmp/a: b"c')
  assert.match(patch, /workspaceRoot: "\/tmp\/a: b\\"c"/)
})
