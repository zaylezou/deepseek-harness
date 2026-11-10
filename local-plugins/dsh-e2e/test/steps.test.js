// goto is a path on the instance origin, never a URL.
//
//   node --test test/
import assert from 'node:assert/strict'
import test from 'node:test'
import { gotoHref } from '../src/steps.js'

const INSTANCE = 'http://127.0.0.1:43781/?token=secret'

test('goto resolves a path against the instance origin', () => {
  assert.equal(gotoHref('/settings?tab=model', INSTANCE), 'http://127.0.0.1:43781/settings?tab=model')
  assert.equal(gotoHref('/', INSTANCE), 'http://127.0.0.1:43781/')
  assert.equal(gotoHref('  /chat/1  ', INSTANCE), 'http://127.0.0.1:43781/chat/1')
})

test('goto refuses absolute and ambiguous targets', () => {
  for (const value of [
    'https://dsh.example.com:9443/',
    'http://127.0.0.1:43781/settings',
    '//evil.example/path',
    'settings',
    '\\\\evil.example\\path',
    '',
  ]) {
    assert.throws(() => gotoHref(value, INSTANCE), /只接受以 \/ 开头/u, `value=${JSON.stringify(value)}`)
  }
})

test('goto needs a usable instance URL', () => {
  assert.throws(() => gotoHref('/x', 'about:blank'), /实例地址/u)
  assert.throws(() => gotoHref('/x', 'file:///tmp/x'), /HTTP\(S\)/u)
})
