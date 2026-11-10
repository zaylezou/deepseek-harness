// Production-access guard tests. Pure functions; no browser, no network, no
// live DSH_HOME.
//
//   node --test test/
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAllowedTarget, forbiddenPorts, guardConfig, hostKeyOf, isPrivateHost, isProtectedUrl, isRequestAllowed, originOf,
} from '../src/guard.js'

const config = (overrides = {}) => ({ protectedOrigins: [], ...overrides })
const server = (origin) => ({ getOrigin: () => origin })

test('host keys ignore the scheme but keep the port', () => {
  assert.equal(hostKeyOf('https://example.com'), 'example.com:443')
  assert.equal(hostKeyOf('http://example.com:443/path'), 'example.com:443')
  assert.equal(hostKeyOf('http://example.com:8080'), 'example.com:8080')
  assert.equal(hostKeyOf('ws://example.com'), 'example.com:80')
  assert.equal(hostKeyOf('wss://example.com:9443/socket'), 'example.com:9443')
  assert.equal(hostKeyOf('file:///etc/passwd'), null)
  assert.equal(originOf('https://example.com'), 'https://example.com')
  assert.equal(originOf('not a url'), null)
})

test('the live web server origin and its loopback aliases are protected', () => {
  const guards = guardConfig(server('http://10.0.0.7:3080'), config(), {})
  assert.deepEqual([...guards.protectedHosts].sort(), ['10.0.0.7:3080', '127.0.0.1:3080', '[::1]:3080', 'localhost:3080'])
  for (const target of ['http://10.0.0.7:3080/', 'https://10.0.0.7:3080/api', 'http://127.0.0.1:3080/']) {
    assert.equal(isProtectedUrl(target, guards), true)
    assert.throws(() => assertAllowedTarget(target, guards), /正式环境/u)
  }
  assert.equal(isProtectedUrl('ws://10.0.0.7:3080/socket', guards), true)
  assert.equal(assertAllowedTarget('http://10.0.0.7:3081/', guards).origin, 'http://10.0.0.7:3081')
})

test('protectedOrigins is scheme-insensitive and ignores paths', () => {
  const guards = guardConfig(undefined, config({ protectedOrigins: ['https://dsh.example:9443/'] }), {})
  assert.deepEqual([...guards.protectedHosts], ['dsh.example:9443'])
  assert.throws(() => assertAllowedTarget('http://dsh.example:9443/', guards), /正式环境/u)
  assert.throws(() => assertAllowedTarget('https://dsh.example:9443/login', guards), /正式环境/u)
  assert.equal(assertAllowedTarget('https://dsh.example:443/', guards).origin, 'https://dsh.example')
})

test('an isolated instance does not protect its own origin but keeps public entries protected', () => {
  const env = { DSH_E2E_INSTANCE: '1' }
  const guards = guardConfig(server('http://10.0.0.7:43781'), config({ protectedOrigins: ['https://dsh.example:9443'] }), env)
  assert.deepEqual([...guards.protectedHosts], ['dsh.example:9443'])
  assert.equal(assertAllowedTarget('http://10.0.0.7:43781/?token=x', guards).origin, 'http://10.0.0.7:43781')
  assert.throws(() => assertAllowedTarget('https://dsh.example:9443/', guards), /正式环境/u)
})

test('non-HTTP targets are refused', () => {
  const guards = guardConfig(undefined, config(), {})
  for (const target of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'ws://example.com/socket']) {
    assert.throws(() => assertAllowedTarget(target, guards), /非 HTTP\(S\)/u)
  }
})

test('an instance target must stay on the instance origin', () => {
  const guards = guardConfig(undefined, config(), {})
  const options = { instanceOrigin: 'http://127.0.0.1:4000/?token=secret', instanceId: 'temp' }
  assert.equal(assertAllowedTarget('http://127.0.0.1:4000/', guards, options).origin, 'http://127.0.0.1:4000')
  assert.throws(() => assertAllowedTarget('http://127.0.0.1:4001/', guards, options), /实例 temp 之外/u)
  assert.throws(() => assertAllowedTarget('https://127.0.0.1:4000/', guards, options), /实例 temp 之外/u)
})

test('private hosts other than the instance origin are refused at the request layer', () => {
  const instance = 'http://10.0.0.7:43781/?token=x'
  const guards = guardConfig(server('http://10.0.0.7:3080'), config({ protectedOrigins: ['https://dsh.example:9443'] }), {})
  assert.equal(isPrivateHost('127.0.0.1'), true)
  assert.equal(isPrivateHost('10.0.0.5'), true)
  assert.equal(isPrivateHost('172.16.0.1'), true)
  assert.equal(isPrivateHost('192.168.1.10'), true)
  assert.equal(isPrivateHost('[::1]'), true)
  assert.equal(isPrivateHost('example.com'), false)
  assert.equal(isRequestAllowed('http://10.0.0.7:43781/api', guards, instance), true)
  assert.equal(isRequestAllowed('ws://10.0.0.7:43781/ws', guards, instance), true)
  assert.equal(isRequestAllowed('http://10.0.0.7:3080/', guards, instance), false)
  assert.equal(isRequestAllowed('http://192.168.1.10:9443/', guards, instance), false)
  assert.equal(isRequestAllowed('https://cdn.example/app.js', guards, instance), true)
  assert.equal(isRequestAllowed('https://dsh.example:9443/', guards, instance), false)
})

test('forbidden instance ports combine the live server and protected entries', () => {
  const guards = guardConfig(server('http://10.0.0.7:3080'), config({ protectedOrigins: ['https://dsh.example:9443'] }), {})
  assert.deepEqual([...forbiddenPorts(guards)].sort((left, right) => left - right), [3080, 9443])
})
