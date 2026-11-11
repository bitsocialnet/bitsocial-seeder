import assert from 'node:assert/strict'
import {EventEmitter} from 'node:events'
import test from 'node:test'
import {reconcileCommunitySubscriptions, reconcilePubsubTopics} from '../lib/community-subscriptions.ts'

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

// A fake Kubo pubsub API: subscribe() resolves like kubo-rpc-client's (which assumes success
// after a second even if the request later fails), and ls() is what the node really has.
const createFakeKuboPubsub = () => {
  const kuboTopics = new Set<string>()
  const subscribes: string[] = []
  const unsubscribes: string[] = []
  return {
    kuboTopics,
    subscribes,
    unsubscribes,
    pubsub: {
      subscribe: async (topic: string) => {
        subscribes.push(topic)
        kuboTopics.add(topic)
      },
      unsubscribe: async (topic: string) => {
        unsubscribes.push(topic)
      },
      ls: async (_options?: {signal?: AbortSignal}) => [...kuboTopics]
    }
  }
}
// The join loop records a join from subscribe()'s .then, which runs after the tick returns.
const flush = () => new Promise(resolve => setImmediate(resolve))

// Kubo forgets its pubsub subscriptions when it restarts (bitsocial-cli restarts it in place,
// without the daemon process exiting), and kubo-rpc-client tells nobody when the HTTP stream
// ends. The join loop used to trust its own record of the join forever, so the node left the
// community's pubsub topic until the seeder itself restarted.
test('a pubsub topic Kubo no longer has is joined again on the next tick', async () => {
  const kubo = createFakeKuboPubsub()
  const joined: Parameters<typeof reconcilePubsubTopics>[0]['joined'] = {}
  const communities = [{address: 'a.bso', pubsubTopic: 'topic-a'}, {address: 'b.bso', pubsubTopic: 'topic-b'}]
  const tick = async () => {
    await reconcilePubsubTopics({communities, joined, pubsub: kubo.pubsub})
    await flush()
  }

  await tick()
  assert.deepEqual(kubo.subscribes, ['topic-a', 'topic-b'])
  assert.deepEqual(Object.keys(joined).sort(), ['topic-a', 'topic-b'])

  // While Kubo still has both topics, a tick joins nothing.
  await tick()
  assert.deepEqual(kubo.subscribes, ['topic-a', 'topic-b'])

  // Kubo restarts or topic-a's stream dies: Kubo no longer has it.
  kubo.kuboTopics.delete('topic-a')
  await tick()
  assert.deepEqual(kubo.subscribes, ['topic-a', 'topic-b', 'topic-a'])
  assert.deepEqual(kubo.unsubscribes, ['topic-a'], 'the dead subscription is released before the new one')
  assert.deepEqual(Object.keys(joined).sort(), ['topic-a', 'topic-b'])
})

test('a failed pubsub ls leaves the recorded joins alone', async () => {
  const kubo = createFakeKuboPubsub()
  const joined: Parameters<typeof reconcilePubsubTopics>[0]['joined'] = {}
  const communities = [{address: 'a.bso', pubsubTopic: 'topic-a'}]
  await reconcilePubsubTopics({communities, joined, pubsub: kubo.pubsub})
  await flush()

  kubo.pubsub.ls = async () => { throw Error('kubo rpc connection refused') }
  await reconcilePubsubTopics({communities, joined, pubsub: kubo.pubsub})
  await flush()
  assert.deepEqual(kubo.subscribes, ['topic-a'])
  assert.deepEqual(Object.keys(joined), ['topic-a'])
})

// kubo-rpc-client sets no timeout of its own, so a Kubo that takes the request and never
// answers held the pubsub tick, and with it the only pubsub worker, forever: no more rejoins
// and no more routing provides, while pubsub-tick rows piled up behind it.
test('a pubsub ls that never answers times out and leaves the recorded joins alone', {timeout: 5000}, async () => {
  const kubo = createFakeKuboPubsub()
  const joined: Parameters<typeof reconcilePubsubTopics>[0]['joined'] = {}
  const communities = [{address: 'a.bso', pubsubTopic: 'topic-a'}]
  await reconcilePubsubTopics({communities, joined, pubsub: kubo.pubsub})
  await flush()

  // Like kubo-rpc-client's ls against a wedged Kubo: it settles only when its signal aborts.
  kubo.pubsub.ls = options => new Promise((_, reject) => {
    options?.signal?.addEventListener('abort', () => reject(options.signal!.reason))
  })
  const startedAt = Date.now()
  await reconcilePubsubTopics({communities, joined, pubsub: kubo.pubsub, lsTimeoutMs: 50})
  await flush()
  assert.ok(Date.now() - startedAt < 2000, 'the tick returns once ls times out')
  assert.deepEqual(kubo.subscribes, ['topic-a'])
  assert.deepEqual(Object.keys(joined), ['topic-a'])
})
