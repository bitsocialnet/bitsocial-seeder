import util from 'util'
util.inspect.defaultOptions.depth = process.env.DEBUG_DEPTH as any
import 'dotenv/config'
import yargs from 'yargs/yargs'
import {hideBin} from 'yargs/helpers'
const argv = yargs(hideBin(process.argv)).argv
console.log({argv})
import config from './config.ts'
import {db} from './lib/db.ts'
import {discoverCommunitiesFromLists} from './lib/discover-communities.ts'
import {ensureDaemon} from './lib/daemon.ts'
import seederState from './lib/seeder-state.ts'
import {checkRuntimeDependencyUpdates, checkForUpdate} from './lib/update-check.ts'

// Either half can be switched off (COMMUNITY_LIST_SOURCES=none / VOTES_MANIFEST_SOURCES=none),
// so a votes-only seeder is a supported config — only *both* off is a misconfiguration.
const communitiesEnabled = Boolean(
  config?.seeding?.communityListSources?.length || config?.seeding?.communityExtraListSources?.length
)
const votesEnabled = config.votes.manifestSources.length > 0

if (!communitiesEnabled && !votesEnabled) {
  console.log(`nothing to seed: both 'seeding.communityListSources' (COMMUNITY_LIST_SOURCES) and 'votes.manifestSources' (VOTES_MANIFEST_SOURCES) are empty`)
  process.exit()
}

// --- graceful shutdown ---
// Aborts all the long-running worker loops and the scheduler, then closes the
// SQLite database. honker's polling thread also stops on db.close().
const abortController = new AbortController()
const {signal} = abortController

let shuttingDown = false
// Async teardown hooks (e.g. the votes seeder flushing its checkpoint snapshot) that should
// finish inside the shutdown grace window; failures never block exit.
const shutdownCleanups: (() => any)[] = []
const shutdown = (signum: string) => {
  if (shuttingDown) {
    process.exit(1)
  }
  shuttingDown = true
  console.log(`received ${signum}, shutting down`)
  abortController.abort()
  const exit = () => {
    try { db.close() } catch {}
    process.exit(0)
  }
  // Exit as soon as the cleanups settle — voter.destroy() is what flushes the debounced
  // checkpoint write, so cutting it off at a fixed sleep could lose votes on a slow disk —
  // with the grace timer as the backstop against a hung cleanup.
  setTimeout(exit, 5000).unref()
  Promise.allSettled(shutdownCleanups.map(async cleanup => cleanup())).then(exit)
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

// A sleep that returns early on shutdown, so a long daemon-retry backoff cannot hold the
// process past the 5s grace window. The listener is removed on both paths: an { once: true }
// listener is only detached by the platform when the event actually fires, and every timer
// that expires normally would otherwise leave one behind on a process-lifetime signal.
const sleepOrAbort = (ms: number) => new Promise<void>(resolve => {
  let timer: NodeJS.Timeout | undefined
  const done = () => {
    clearTimeout(timer)
    signal.removeEventListener('abort', done)
    resolve()
  }
  timer = setTimeout(done, ms)
  signal.addEventListener('abort', done, {once: true})
})

// --- tick queues ---
// Each periodic task is its own queue. The scheduler fires by enqueueing a
// row onto that queue; a worker claims, runs the function, and acks. We use
// maxAttempts=1 because if the tick fails the next scheduler firing re-runs
// it anyway — no value in honker's retry/backoff path for idempotent ticks.
const tickQueue = (name: string) => db.queue(name, {maxAttempts: 1, visibilityTimeoutS: 600})

const discoverTickQ = tickQueue('discover-tick')
const subscribeTickQ = tickQueue('subscribe-tick')
const pubsubTickQ = tickQueue('pubsub-tick')
const updateCheckTickQ = tickQueue('update-check-tick')

const runTickWorker = async (queue: any, workerId: string, processFn: () => any) => {
  for await (const job of queue.claim(workerId, {signal})) {
    try {
      await processFn()
    }
    catch (error: any) {
      console.log(`${workerId} error: ${error?.message || error}`)
    }
    try { job.ack() } catch {}
  }
}

// honker's scheduler is leader-elected and addressable: each entry is a row
// in _honker_scheduler_tasks keyed by name. Calling add() again with the same
// name is a no-op, so re-registering on every startup is safe. The leader loop
// re-reads the table every iteration, so entries added after run() starts are
// picked up within a heartbeat — which is what lets the community entries wait
// for the daemon without their ticks piling up unclaimed in the meantime.
const scheduler = db.scheduler()
const everyS = (ms: any) => `@every ${Math.max(1, Math.floor(Number(ms) / 1000))}s`

// --- update check worker (no daemon dependency, start immediately) ---
runTickWorker(updateCheckTickQ, 'update-check-worker', async () => {
  if (config.updateCheck.enabled === false) {
    return
  }
  await checkForUpdate({timeoutMs: config.updateCheck.timeoutMs})
  await checkRuntimeDependencyUpdates({timeoutMs: config.updateCheck.timeoutMs})
}).catch(error => console.log(`update-check worker exited: ${error?.message || error}`))

if (config.updateCheck.enabled !== false) {
  updateCheckTickQ.enqueue({reason: 'startup'})
}

// --- votes seeding workers (no daemon dependency; lazy import so the embedded libp2p node
// only exists when configured) ---
let votesTickQ
if (votesEnabled) {
  const {votesTick, destroyVotesSeeder} = await import('./lib/votes/seeder.ts')
  shutdownCleanups.push(destroyVotesSeeder)
  votesTickQ = tickQueue('votes-tick')
  runTickWorker(votesTickQ, 'votes-worker', () => votesTick())
    .catch(error => console.log(`votes worker exited: ${error?.message || error}`))
  votesTickQ.enqueue({reason: 'startup'})
}

// --- community seeding (skipped entirely on a votes-only seeder) ---
//
// Only the community half talks to the daemon: it needs the PKC RPC to subscribe to
// community updates and Kubo to pin and to run pubsub. The votes half is self-contained
// (its own Helia node, its own blockstore, chain reads and .bso resolution straight over
// HTTP RPC), so a votes-only seeder must neither require a daemon nor spawn one. Autostarting
// there is actively harmful: a votes-only container restarting while the machine's real
// daemon is down claims the PKC RPC port with a bundled daemon nothing talks to, and then the
// real daemon cannot come back without manual intervention.
const startCommunitySeeding = async () => {
  // --- discover loop ---
  runTickWorker(discoverTickQ, 'discover-worker', () => discoverCommunitiesFromLists())
    .catch(error => console.log(`discover worker exited: ${error?.message || error}`))

  discoverTickQ.enqueue({reason: 'startup'})

  // Re-enqueue on every wait iteration so a transient failure on the first
  // discover (e.g. network blip, GitHub rate limit) recovers on the next 10s
  // tick instead of hanging the boot. Mirrors the recovery behavior the old
  // setInterval-based discovery had before the honker migration.
  while (
    !(seederState as {communitiesSeeding?: any[]; discoveryCompleted?: boolean}).communitiesSeeding &&
    !(seederState as {discoveryCompleted?: boolean}).discoveryCompleted
  ) {
    if (signal.aborted) {
      return
    }
    console.log('no communities discovered yet, checking again in 10 seconds...')
    await sleepOrAbort(10000)
    discoverTickQ.enqueue({reason: 'startup-retry'})
  }
  if (signal.aborted) {
    return
  }

  // --- seeding workers (lazy import so bitsocial.ts + pkc handles initialize after daemon is ready) ---
  const {
    subscribeCommunitiesUpdates,
    joinPubsubTopics,
    providePubsubTopicRoutingCids,
    spawnPinWorkers
  } = await import('./lib/seed-communities.ts')

  runTickWorker(subscribeTickQ, 'subscribe-worker', () => subscribeCommunitiesUpdates())
    .catch(error => console.log(`subscribe worker exited: ${error?.message || error}`))

  runTickWorker(pubsubTickQ, 'pubsub-worker', async () => {
    await joinPubsubTopics()
    await providePubsubTopicRoutingCids()
  }).catch(error => console.log(`pubsub-tick worker exited: ${error?.message || error}`))

  for (const pinWorker of spawnPinWorkers(signal)) {
    pinWorker.catch(error => console.log(`pin worker exited: ${error?.message || error}`))
  }

  subscribeTickQ.enqueue({reason: 'startup'})
  pubsubTickQ.enqueue({reason: 'startup'})

  // Registered here, not at boot: the scheduler starts before the daemon is up on a combined
  // seeder, and entries added while nothing is claiming their queues would just pile ticks up
  // and then run them all at once. The scheduler picks these up within a heartbeat.
  scheduler.add({
    name: 'discover-tick',
    queue: 'discover-tick',
    schedule: everyS(config.seeding.discoverIntervalMs),
    payload: {}
  })
  scheduler.add({
    name: 'subscribe-tick',
    queue: 'subscribe-tick',
    schedule: everyS(10 * 60 * 1000),
    payload: {}
  })
  scheduler.add({
    name: 'pubsub-tick',
    queue: 'pubsub-tick',
    schedule: everyS(60 * 1000),
    payload: {}
  })
}

// Retry rather than give up: ensureDaemon() is one-shot — with autostart off it throws the
// moment the RPCs are unreachable, and with autostart on it gives up after readyTimeoutMs. A
// single background attempt would leave community seeding dead for the process lifetime after
// one blip, with no exit for the supervisor to restart. Backs off because the ready probe
// opens a real WebSocket and sends a subscribe, so a tight loop would hammer a daemon that is
// merely slow to boot. ensureDaemon() is safe to call repeatedly: it reuses a bundled daemon
// it already spawned instead of starting a second one.
const daemonRetryBaseMs = 10 * 1000
const daemonRetryMaxMs = 5 * 60 * 1000
const waitForDaemonWithBackoff = async () => {
  for (let attempt = 1; !signal.aborted; attempt++) {
    try {
      await ensureDaemon()
      return true
    }
    catch (error: any) {
      if (signal.aborted) {
        return false
      }
      const waitMs = Math.min(daemonRetryMaxMs, daemonRetryBaseMs * 2 ** Math.min(attempt - 1, 5))
      console.error(`community seeding is DOWN, attempt ${attempt} to reach the bitsocial daemon failed: ${error?.message || error} — votes seeding is unaffected; retrying in ${Math.round(waitMs / 1000)}s`)
      await sleepOrAbort(waitMs)
    }
  }
  return false
}

if (communitiesEnabled && votesEnabled) {
  // A combined seeder must not let a daemon outage take down a votes half that needs no
  // daemon at all. Exiting here used to crash-loop the container under `restart:
  // unless-stopped`, and every restart re-ran the votes cold join and re-announced to the
  // routers — degrading the votes seeding this machine exists to provide, for a reason
  // unrelated to it. So: keep serving what we can, and bring the community half up whenever
  // the daemon shows up.
  waitForDaemonWithBackoff()
    .then(async ready => {
      if (ready) {
        await startCommunitySeeding()
      }
    })
    .catch(error => console.error(`community seeding failed to start: ${error?.message || error}`))
}
else if (communitiesEnabled) {
  // Communities-only: nothing would be left running, so fail fast and let the supervisor
  // restart us. That is a clearer signal than idling with no daemon and nothing to seed.
  try {
    await ensureDaemon()
  }
  catch (error: any) {
    console.error(error?.message || error)
    process.exit(1)
  }
  await startCommunitySeeding()
}
else {
  console.log('community seeding disabled (COMMUNITY_LIST_SOURCES=none), seeding votes only (no bitsocial daemon needed)')
}

// --- register scheduler entries (durable periodic re-enqueue) ---
//
// The community entries are registered by startCommunitySeeding() instead of here, because
// they must not fire before the workers that drain their queues exist.
if (config.updateCheck.enabled !== false) {
  scheduler.add({
    name: 'update-check-tick',
    queue: 'update-check-tick',
    schedule: everyS(config.updateCheck.intervalMs),
    payload: {}
  })
}
if (votesEnabled) {
  scheduler.add({
    name: 'votes-tick',
    queue: 'votes-tick',
    schedule: everyS(config.votes.reconcileIntervalMs),
    payload: {}
  })
}

scheduler.run('bitsocial-seeder', signal)
  .catch(error => console.log(`scheduler exited: ${error?.message || error}`))
