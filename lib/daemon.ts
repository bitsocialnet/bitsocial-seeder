import {spawn} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {createRequire} from 'node:module'
import net from 'node:net'
import config from '../config.ts'
import {warnIfExistingDaemonMayBeStale} from './external-daemon-version.ts'

const require = createRequire(import.meta.url)
const bitsocialBinPath = () => require.resolve('@bitsocial/bitsocial-cli/bin/run')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const localHostnames = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

let bundledDaemon: ChildProcess | undefined
let daemonWasReady = false
let shuttingDown = false
let stoppingProgrammatically = false
let shutdownHandlersInstalled = false
let shutdownTimer: NodeJS.Timeout | undefined

const parseUrl = (urlString: string) => {
  try {
    return new URL(urlString)
  }
  catch {
    return
  }
}

const getUrlPort = (url: URL) => {
  if (url.port) {
    return Number(url.port)
  }
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
}

const getConnectHost = (hostname: string) => {
  const normalized = hostname.replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '0.0.0.0') {
    return '127.0.0.1'
  }
  return normalized
}

export const isLocalDaemonUrl = (urlString: string) => {
  const url = parseUrl(urlString)
  return Boolean(url && localHostnames.has(url.hostname))
}

export const buildDaemonArgs = ({pkcRpcUrl, dataPath, logPath}: {pkcRpcUrl: string, dataPath?: string, logPath?: string}) => {
  const args = [bitsocialBinPath(), 'daemon', '--pkcRpcUrl', pkcRpcUrl]
  if (dataPath) {
    args.push('--pkcOptions.dataPath', dataPath)
  }
  if (logPath) {
    args.push('--logPath', logPath)
  }
  return args
}

export const isTcpEndpointReachable = (urlString: string, timeoutMs = 1000) => {
  const url = parseUrl(urlString)
  const port = url && getUrlPort(url)
  if (!url || !Number.isFinite(port)) {
    return Promise.resolve(false)
  }

  return new Promise<boolean>(resolve => {
    const socket = net.connect({host: getConnectHost(url.hostname), port: port as number, timeout: timeoutMs})
    const finish = (reachable: boolean) => {
      socket.destroy()
      resolve(reachable)
    }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

export const isPkcRpcReady = (urlString: string, timeoutMs = 2000) => {
  const url = parseUrl(urlString)
  if (!url || typeof WebSocket !== 'function') {
    return Promise.resolve(false)
  }

  return new Promise<boolean>(resolve => {
    let settled = false
    let socket: WebSocket | undefined
    const finish = (ready: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      try {
        socket?.close()
      }
      catch {}
      resolve(ready)
    }
    const timeout = setTimeout(() => finish(false), timeoutMs)

    try {
      socket = new WebSocket(urlString)
      socket.addEventListener('open', () => {
        socket!.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'communitiesSubscribe',
          params: []
        }))
      })
      socket.addEventListener('message', event => {
        try {
          const message = JSON.parse(event.data.toString())
          if (message.id === 1) {
            finish(Boolean(message.result?.subscriptionId))
          }
        }
        catch {
          finish(false)
        }
      })
      socket.addEventListener('error', () => finish(false))
    }
    catch {
      finish(false)
    }
  })
}

export const isKuboRpcReachable = async (urlString: string, timeoutMs = 1000) => {
  const url = parseUrl(urlString)
  if (!url) {
    return false
  }
  const versionUrl = `${urlString.replace(/\/$/, '')}/version`
  try {
    const response = await fetch(versionUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs)
    })
    return response.ok
  }
  catch {
    return false
  }
}

export const checkDaemonEndpoints = async () => {
  const [pkcPortOpen, pkcReachable, kuboReachable, pubsubReachable] = await Promise.all([
    isTcpEndpointReachable(config.pkcRpcUrl),
    isPkcRpcReady(config.pkcRpcUrl),
    isKuboRpcReachable(config.kuboRpcUrl),
    config.pubsubKuboRpcUrl === config.kuboRpcUrl ? Promise.resolve(true) : isKuboRpcReachable(config.pubsubKuboRpcUrl)
  ])
  return {
    pkcPortOpen,
    pkcReachable,
    kuboReachable,
    pubsubReachable,
    ready: pkcReachable && kuboReachable && pubsubReachable
  }
}

const prefixOutput = (prefix: string, chunk: Buffer) => {
  const text = chunk.toString()
  process.stdout.write(text.split('\n').map((line, index, lines) => {
    if (index === lines.length - 1 && line === '') {
      return ''
    }
    return `${prefix}${line}`
  }).join('\n'))
}

// Guard on exitCode/signalCode, not child.killed: killed flips to true as soon
// as the first signal is *sent*, which would turn the later SIGKILL escalation
// into a no-op for a daemon that ignores SIGINT.
const stopBundledDaemon = (signal: NodeJS.Signals = 'SIGINT') => {
  if (bundledDaemon && bundledDaemon.exitCode === null && bundledDaemon.signalCode === null) {
    bundledDaemon.kill(signal)
  }
}

// Graceful programmatic stop for embedders (tests, future API use): SIGINT the
// bundled daemon so bitsocial-cli shuts down its communities and kubo, escalate
// to SIGKILL after the grace window. Unlike the signal-driven shutdown path,
// this never calls process.exit — the caller decides what happens next.
export const stopDaemon = (timeoutMs = 20000) => {
  if (!bundledDaemon || bundledDaemon.exitCode !== null || bundledDaemon.signalCode !== null) {
    return Promise.resolve()
  }
  stoppingProgrammatically = true
  return new Promise<void>(resolve => {
    const killTimer = setTimeout(() => stopBundledDaemon('SIGKILL'), timeoutMs)
    bundledDaemon!.once('exit', () => {
      clearTimeout(killTimer)
      resolve()
    })
    stopBundledDaemon()
  })
}

const installShutdownHandlers = () => {
  if (shutdownHandlersInstalled) {
    return
  }
  shutdownHandlersInstalled = true
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      process.exit(1)
    }
    shuttingDown = true
    stopBundledDaemon()
    shutdownTimer = setTimeout(() => {
      stopBundledDaemon('SIGKILL')
      process.exit(0)
    }, 20000)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('exit', () => {
    if (shutdownTimer) {
      clearTimeout(shutdownTimer)
    }
    stopBundledDaemon('SIGKILL')
  })
}

const startBundledDaemon = () => {
  const args = buildDaemonArgs({
    pkcRpcUrl: config.pkcRpcUrl,
    dataPath: config.daemon.dataPath,
    logPath: config.daemon.logPath
  })
  const env = {
    ...process.env,
    KUBO_RPC_URL: config.kuboRpcUrl,
    IPFS_GATEWAY_URL: config.ipfsGatewayUrl
  }

  console.log('starting bundled bitsocial daemon')
  bundledDaemon = spawn(process.execPath, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  bundledDaemon.stdout!.on('data', chunk => prefixOutput('[bitsocial daemon] ', chunk))
  bundledDaemon.stderr!.on('data', chunk => prefixOutput('[bitsocial daemon] ', chunk))
  bundledDaemon.once('error', error => {
    if (!shuttingDown && !stoppingProgrammatically && daemonWasReady) {
      console.error(`bundled bitsocial daemon process error: ${error.message}`)
      process.exit(1)
    }
  })
  bundledDaemon.once('exit', (code, signal) => {
    if (stoppingProgrammatically) {
      return
    }
    if (shuttingDown) {
      if (shutdownTimer) {
        clearTimeout(shutdownTimer)
      }
      process.exit(0)
      return
    }
    if (!shuttingDown && daemonWasReady) {
      console.error(`bundled bitsocial daemon exited unexpectedly (code: ${code}, signal: ${signal})`)
      process.exit(code || 1)
    }
  })
  installShutdownHandlers()
  return bundledDaemon
}

const waitForDaemon = async (daemonProcess: ChildProcess | undefined, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs
  let exit: {code: number | null, signal: NodeJS.Signals | null} | undefined
  let processError: Error | undefined
  let readySince: number | undefined
  daemonProcess?.once('error', error => {
    processError = error
  })
  daemonProcess?.once('exit', (code, signal) => {
    exit = {code, signal}
  })

  while (Date.now() < deadline) {
    const status = await checkDaemonEndpoints()
    if (status.ready) {
      readySince = readySince || Date.now()
      if (Date.now() - readySince >= config.daemon.readyStableMs) {
        daemonWasReady = true
        return status
      }
    }
    else {
      readySince = undefined
    }
    if (processError) {
      throw Error(`failed to start bundled bitsocial daemon: ${processError.message}`)
    }
    if (exit) {
      throw Error(`bundled bitsocial daemon exited before it was ready (code: ${exit.code}, signal: ${exit.signal})`)
    }
    await sleep(1000)
  }

  throw Error(`timed out waiting for bitsocial daemon RPCs (${config.pkcRpcUrl}, ${config.kuboRpcUrl})`)
}

export const ensureDaemon = async () => {
  const status = await checkDaemonEndpoints()
  if (status.ready) {
    console.log('using existing bitsocial daemon RPCs')
    await warnIfExistingDaemonMayBeStale({pkcRpcUrl: config.pkcRpcUrl})
    return {started: false, status}
  }

  if (!config.daemon.autostart) {
    throw Error(`bitsocial daemon RPCs are not ready and SEEDER_DAEMON_AUTOSTART=false (${config.pkcRpcUrl}, ${config.kuboRpcUrl})`)
  }

  if (!isLocalDaemonUrl(config.pkcRpcUrl)) {
    throw Error(`cannot autostart a daemon for non-local PKC_RPC_URL '${config.pkcRpcUrl}'`)
  }

  if (status.pkcPortOpen) {
    console.log('PKC RPC port is open but daemon endpoints are not ready; waiting for the existing daemon')
    const readyStatus = await waitForDaemon(undefined, config.daemon.readyTimeoutMs)
    await warnIfExistingDaemonMayBeStale({pkcRpcUrl: config.pkcRpcUrl})
    return {started: false, status: readyStatus}
  }

  const daemonProcess = startBundledDaemon()
  return {started: true, status: await waitForDaemon(daemonProcess, config.daemon.readyTimeoutMs)}
}
