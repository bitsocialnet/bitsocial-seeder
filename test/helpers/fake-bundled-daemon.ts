// Stands in for the bitsocial-cli daemon that lib/daemon.ts spawns (fake-bundled-daemon-preload.ts
// redirects the spawn here). It serves the fake PKC and Kubo RPCs on the ports the seeder probes,
// and on SIGINT takes a moment to shut down, as bitsocial-cli does while it stops its communities
// and its Kubo. Each step is appended to SEEDER_TEST_DAEMON_LOG, so a test can tell a graceful
// stop from a SIGKILL.
import fs from 'node:fs'
import {createFakeKuboRpcServer, createFakePkcRpcServer} from './fake-daemon-rpcs.ts'

const logPath = process.env.SEEDER_TEST_DAEMON_LOG as string
const log = (line: string) => fs.appendFileSync(logPath, `${line}\n`)
const shutdownMs = 1000

const pkcRpcUrl = new URL(process.argv[process.argv.indexOf('--pkcRpcUrl') + 1])
const kuboRpcUrl = new URL(process.env.KUBO_RPC_URL as string)
const pkc = createFakePkcRpcServer()
const kubo = createFakeKuboRpcServer()
await Promise.all([pkc.listen(Number(pkcRpcUrl.port)), kubo.listen(Number(kuboRpcUrl.port))])
log(`started ${process.pid}`)

process.on('SIGINT', () => {
  log('received SIGINT')
  setTimeout(async () => {
    await Promise.all([pkc.close(), kubo.close()])
    log('stopped gracefully')
    process.exit(0)
  }, shutdownMs)
})
