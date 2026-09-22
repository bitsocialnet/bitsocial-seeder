import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'
import {reconcileCommunitySubscriptions} from '../lib/community-subscriptions.ts'

test('removed communities stop before replacements start and stale updates are ignored', async () => {
  const events: string[] = []
  const handles: Record<string, EventEmitter & {stop: () => Promise<void>, update: () => Promise<void>}> = {}
  const all = new Map<string, typeof handles[string]>()
  const tick = (addresses: string[]) => reconcileCommunitySubscriptions({
    seeding: addresses.map(address => ({address})), updating: handles,
    createCommunity: async ({address}) => {
      const c = Object.assign(new EventEmitter(), {
        stop: async () => { events.push(`stop:${address}`) },
        update: async () => { events.push(`start:${address}`) }
      })
      all.set(address, c)
      return c
    },
    onUpdate: (_, key) => { events.push(`update:${key}`) },
    onError: error => { throw error }
  })
  await tick(['a', 'b'])
  await tick(['b', 'c'])
  assert.deepEqual(Object.keys(handles).sort(), ['b', 'c'])
  assert.deepEqual(events, ['start:a', 'start:b', 'stop:a', 'start:c'])
  all.get('a')!.emit('update')
  all.get('b')!.emit('update')
  assert.equal(events.at(-1), 'update:b')
  assert.ok(!events.includes('update:a'))
  await tick([])
  assert.equal(Object.keys(handles).length, 0)
})

test('a failed stop retains the handle and refuses replacement subscriptions', async () => {
  const c = {stop: async () => { throw Error('stop failed') }}
  const updating = {a: c}
  await assert.rejects(reconcileCommunitySubscriptions({
    seeding: [{address: 'b'}], updating,
    createCommunity: async () => { assert.fail('must stop the old subscription first') },
    onUpdate: () => {}, onError: () => {}
  }), /stop failed/)
  assert.equal(updating.a, c)
})
