import util from 'util'
util.inspect.defaultOptions.depth = process.env.DEBUG_DEPTH
import 'dotenv/config'
import yargs from 'yargs/yargs'
import {hideBin} from 'yargs/helpers'
const argv = yargs(hideBin(process.argv)).argv
console.log({argv})
import config from './config.js'
import {db} from './lib/db.js'
import {discoverCommunitiesFromLists} from './lib/discover-communities.js'
import {ensureDaemon} from './lib/daemon.js'
import seederState from './lib/seeder-state.js'
import {checkForRuntimeDependencyUpdates, checkForUpdate} from './lib/update-check.js'

if (!config?.seeding?.communityListSources?.length) {
  console.log(`missing config.js 'seeding.communityListSources'`)
  process.exit()
}

// --- graceful shutdown ---
// Aborts all the long-running worker loops and the scheduler, then closes the
// SQLite database. honker's polling thread also stops on db.close().
const abortController = new AbortController()
const {signal} = abortController

let shuttingDown = false
const shutdown = (signum) => {
  if (shuttingDown) {
    process.exit(1)
  }
  shuttingDown = true
  console.log(`received ${signum}, shutting down`)
  abortController.abort()
  setTimeout(() => {
    try { db.close() } catch {}
    process.exit(0)
  }, 5000).unref()
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))

// --- tick queues ---
// Each periodic task is its own queue. The scheduler fires by enqueueing a
// row onto that queue; a worker claims, runs the function, and acks. We use
// maxAttempts=1 because if the tick fails the next scheduler firing re-runs
// it anyway — no value in honker's retry/backoff path for idempotent ticks.
const tickQueue = (name) => db.queue(name, {maxAttempts: 1, visibilityTimeoutS: 600})

const discoverTickQ = tickQueue('discover-tick')
const subscribeTickQ = tickQueue('subscribe-tick')
const pubsubTickQ = tickQueue('pubsub-tick')
const updateCheckTickQ = tickQueue('update-check-tick')

const runTickWorker = async (queue, workerId, processFn) => {
  for await (const job of queue.claim(workerId, {signal})) {
    try {
      await processFn()
    }
    catch (error) {
      console.log(`${workerId} error: ${error?.message || error}`)
    }
    try { job.ack() } catch {}
  }
}

// --- update check worker (no daemon dependency, start immediately) ---
runTickWorker(updateCheckTickQ, 'update-check-worker', async () => {
  if (config.updateCheck.enabled === false) {
    return
  }
  await checkForUpdate({timeoutMs: config.updateCheck.timeoutMs})
  await checkForRuntimeDependencyUpdates({timeoutMs: config.updateCheck.timeoutMs})
}).catch(error => console.log(`update-check worker exited: ${error?.message || error}`))

if (config.updateCheck.enabled !== false) {
  updateCheckTickQ.enqueue({reason: 'startup'})
}

// --- ensure daemon is up ---
try {
  await ensureDaemon()
}
catch (error) {
  console.error(error?.message || error)
  process.exit(1)
}

// --- discover loop ---
runTickWorker(discoverTickQ, 'discover-worker', () => discoverCommunitiesFromLists())
  .catch(error => console.log(`discover worker exited: ${error?.message || error}`))

discoverTickQ.enqueue({reason: 'startup'})

// Re-enqueue on every wait iteration so a transient failure on the first
// discover (e.g. network blip, GitHub rate limit) recovers on the next 10s
// tick instead of hanging the boot. Mirrors the recovery behavior the old
// setInterval-based discovery had before the honker migration.
while (!seederState.communitiesSeeding) {
  console.log('no communities discovered yet, checking again in 10 seconds...')
  await new Promise(r => setTimeout(r, 10000))
  discoverTickQ.enqueue({reason: 'startup-retry'})
}

// --- seeding workers (lazy import so bitsocial.js + pkc handles initialize after daemon is ready) ---
const {
  subscribeCommunitiesUpdates,
  joinPubsubTopics,
  providePubsubTopicRoutingCids,
  spawnPinWorkers
} = await import('./lib/seed-communities.js')

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

// --- register scheduler entries (durable periodic re-enqueue) ---
//
// honker's scheduler is leader-elected and addressable: each entry is a row
// in _honker_scheduler_tasks keyed by name. Calling add() again with the same
// name is a no-op, so re-registering on every startup is safe.
const scheduler = db.scheduler()
const everyS = (ms) => `@every ${Math.max(1, Math.floor(Number(ms) / 1000))}s`

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
if (config.updateCheck.enabled !== false) {
  scheduler.add({
    name: 'update-check-tick',
    queue: 'update-check-tick',
    schedule: everyS(config.updateCheck.intervalMs),
    payload: {}
  })
}

scheduler.run('bitsocial-seeder', signal)
  .catch(error => console.log(`scheduler exited: ${error?.message || error}`))
