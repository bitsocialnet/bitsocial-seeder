import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import net from 'node:net'
import config from '../config.js'

const require = createRequire(import.meta.url)
const bitsocialBinPath = () => require.resolve('@bitsocial/bitsocial-cli/bin/run')
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const localHostnames = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

let bundledDaemon
let daemonWasReady = false
let shuttingDown = false
let shutdownHandlersInstalled = false
let shutdownTimer

const parseUrl = (urlString) => {
  try {
    return new URL(urlString)
  }
  catch {
    return
  }
}

const getUrlPort = (url) => {
  if (url.port) {
    return Number(url.port)
  }
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
}

const getConnectHost = (hostname) => {
  const normalized = hostname.replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized === '0.0.0.0') {
    return '127.0.0.1'
  }
  return normalized
}

export const isLocalDaemonUrl = (urlString) => {
  const url = parseUrl(urlString)
  return Boolean(url && localHostnames.has(url.hostname))
}

export const buildDaemonArgs = ({pkcRpcUrl, dataPath, logPath}) => {
  const args = [bitsocialBinPath(), 'daemon', '--pkcRpcUrl', pkcRpcUrl]
  if (dataPath) {
    args.push('--pkcOptions.dataPath', dataPath)
  }
  if (logPath) {
    args.push('--logPath', logPath)
  }
  return args
}

export const isTcpEndpointReachable = (urlString, timeoutMs = 1000) => {
  const url = parseUrl(urlString)
  const port = url && getUrlPort(url)
  if (!url || !Number.isFinite(port)) {
    return Promise.resolve(false)
  }

  return new Promise(resolve => {
    const socket = net.connect({host: getConnectHost(url.hostname), port, timeout: timeoutMs})
    const finish = (reachable) => {
      socket.destroy()
      resolve(reachable)
    }
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

export const isPkcRpcReady = (urlString, timeoutMs = 2000) => {
  const url = parseUrl(urlString)
  if (!url || typeof WebSocket !== 'function') {
    return Promise.resolve(false)
  }

  return new Promise(resolve => {
    let settled = false
    let socket
    const finish = (ready) => {
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
        socket.send(JSON.stringify({
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

export const isKuboRpcReachable = async (urlString, timeoutMs = 1000) => {
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

const prefixOutput = (prefix, chunk) => {
  const text = chunk.toString()
  process.stdout.write(text.split('\n').map((line, index, lines) => {
    if (index === lines.length - 1 && line === '') {
      return ''
    }
    return `${prefix}${line}`
  }).join('\n'))
}

const stopBundledDaemon = (signal = 'SIGINT') => {
  if (bundledDaemon && !bundledDaemon.killed) {
    bundledDaemon.kill(signal)
  }
}

const installShutdownHandlers = () => {
  if (shutdownHandlersInstalled) {
    return
  }
  shutdownHandlersInstalled = true
  const shutdown = (signal) => {
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
  bundledDaemon.stdout.on('data', chunk => prefixOutput('[bitsocial daemon] ', chunk))
  bundledDaemon.stderr.on('data', chunk => prefixOutput('[bitsocial daemon] ', chunk))
  bundledDaemon.once('error', error => {
    if (!shuttingDown && daemonWasReady) {
      console.error(`bundled bitsocial daemon process error: ${error.message}`)
      process.exit(1)
    }
  })
  bundledDaemon.once('exit', (code, signal) => {
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

const waitForDaemon = async (daemonProcess, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  let exit
  let processError
  let readySince
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
    return {started: false, status: await waitForDaemon(undefined, config.daemon.readyTimeoutMs)}
  }

  const daemonProcess = startBundledDaemon()
  return {started: true, status: await waitForDaemon(daemonProcess, config.daemon.readyTimeoutMs)}
}
