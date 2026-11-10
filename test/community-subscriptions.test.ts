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

// pkc-js stops a community whose update() rejects (an RPC connect or call timeout, a daemon
// error) before rethrowing. A handle left registered after that was skipped on every later
// tick: the community got no updates or pins for the rest of the process lifetime while
// still counting as seeded.
test('a community whose update() failed is subscribed again on the next tick', async () => {
  const events: string[] = []
  const updating: Record<string, EventEmitter & {stop: () => Promise<void>, update: () => Promise<void>}> = {}
  let failNextUpdate = true
  const tick = () => reconcileCommunitySubscriptions({
    seeding: [{address: 'a'}], updating,
    createCommunity: async ({address}) => Object.assign(new EventEmitter(), {
      stop: async () => { events.push(`stop:${address}`) },
      update: async () => {
        if (failNextUpdate) {
          failNextUpdate = false
          events.push(`update-failed:${address}`)
          throw Error('rpc call timed out')
        }
        events.push(`start:${address}`)
      }
    }),
    onUpdate: (_, key) => { events.push(`update:${key}`) },
    onError: error => { events.push(`error:${error.message}`) }
  })
  await tick()
  await tick()
  assert.deepEqual(events, ['update-failed:a', 'error:rpc call timed out', 'stop:a', 'start:a'])
  updating.a.emit('update')
  assert.equal(events.at(-1), 'update:a')
})

// pkc-js can also stop a community after update() resolved: when replaying the notifications
// the RPC server sent at subscribe time throws, it contains the error by stopping the community
// (pkc-rpc-client's _containReplayError). That left the same registered-but-stopped handle,
// reached without a rejection, and every later tick skipped it.
test('a community pkc-js stopped after update() resolved is subscribed again on the next tick', async () => {
  type Handle = EventEmitter & {state: string, stop: () => Promise<void>, update: () => Promise<void>}
  const events: string[] = []
  const updating: Record<string, Handle> = {}
  const created: Handle[] = []
  const tick = () => reconcileCommunitySubscriptions({
    seeding: [{address: 'a'}], updating,
    createCommunity: async ({address}) => {
      const community: Handle = Object.assign(new EventEmitter(), {
        state: 'stopped',
        stop: async () => {
          community.state = 'stopped'
          events.push(`stop:${address}`)
        },
        update: async () => {
          community.state = 'updating'
          events.push(`start:${address}`)
        }
      })
      created.push(community)
      return community
    },
    onUpdate: (_, key) => { events.push(`update:${key}`) },
    onError: error => { throw error }
  })
  await tick()
  await tick()
  assert.deepEqual(events, ['start:a'], 'a community that is still updating is left alone')

  // pkc-js stops it on its own, after update() has resolved.
  await created[0].stop()
  await tick()
  assert.equal(created.length, 2)
  assert.equal(updating.a, created[1])
  assert.deepEqual(events, ['start:a', 'stop:a', 'start:a'], 'the stopped handle is replaced, not stopped again')
  created[0].emit('update')
  created[1].emit('update')
  assert.deepEqual(events.slice(3), ['update:a'], 'updates from the dropped handle are ignored')
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
