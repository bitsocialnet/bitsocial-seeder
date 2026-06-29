import {execFile} from 'node:child_process'
import fs from 'node:fs/promises'
import {basename, dirname, parse} from 'node:path'
import {promisify} from 'node:util'
import {RUNTIME_DEPENDENCIES, compareVersions} from './update-check.js'

const execFileAsync = promisify(execFile)
const localHostnames = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

export const BUNDLED_BITSOCIAL_CLI_VERSION = RUNTIME_DEPENDENCIES
  .find(dependency => dependency.packageName === '@bitsocial/bitsocial-cli')
  ?.currentVersion

const normalizeRpcUrl = (urlString) => {
  try {
    const url = new URL(urlString)
    const hostname = localHostnames.has(url.hostname) ? 'localhost' : url.hostname
    const port = url.port || (url.protocol === 'wss:' ? '443' : '80')
    return `${url.protocol}//${hostname}:${port}`
  }
  catch {
    return
  }
}

export const isSamePkcRpcUrl = (a, b) => {
  const normalizedA = normalizeRpcUrl(a)
  const normalizedB = normalizeRpcUrl(b)
  return Boolean(normalizedA && normalizedB && normalizedA === normalizedB)
}

const loadAliveDaemonStates = async () => {
  const {getAliveDaemonStates} = await import('@bitsocial/bitsocial-cli/dist/common-utils/daemon-state.js')
  return getAliveDaemonStates()
}

export const readProcessCommandLineArgs = async (pid) => {
  try {
    const raw = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')
    const args = raw.split('\0').filter(Boolean)
    if (args.length) {
      return args
    }
  }
  catch {}

  try {
    const {stdout} = await execFileAsync('ps', ['-p', String(pid), '-o', 'args='])
    return stdout.trim() ? stdout.trim().split(/\s+/) : []
  }
  catch {
    return []
  }
}

const cleanToken = (token) => token.replace(/^['"]|['"]$/g, '')

export const getBitsocialCliPathCandidates = (args = []) => {
  const candidates = new Set()
  for (const arg of args) {
    for (const token of String(arg).split(/\s+/).map(cleanToken).filter(Boolean)) {
      const name = basename(token)
      if (
        token.includes('@bitsocial/bitsocial-cli') ||
        token.includes('bitsocial-cli') ||
        name === 'bitsocial' ||
        name === 'bitsocial.cmd'
      ) {
        candidates.add(token)
      }
    }
  }
  return [...candidates]
}

const findBitsocialCliPackageVersion = async (startPath) => {
  let current
  try {
    current = dirname(await fs.realpath(startPath))
  }
  catch {
    current = dirname(startPath)
  }

  const root = parse(current).root
  while (current && current !== root) {
    try {
      const packageJson = JSON.parse(await fs.readFile(`${current}/package.json`, 'utf8'))
      if (packageJson.name === '@bitsocial/bitsocial-cli' && typeof packageJson.version === 'string') {
        return packageJson.version
      }
    }
    catch {}
    current = dirname(current)
  }
}

export const getBitsocialCliVersionFromCommandLineArgs = async (args = []) => {
  for (const candidate of getBitsocialCliPathCandidates(args)) {
    const version = await findBitsocialCliPackageVersion(candidate)
    if (version) {
      return version
    }
  }
}

export const getExistingDaemonVersionWarning = async ({
  pkcRpcUrl,
  bundledVersion = BUNDLED_BITSOCIAL_CLI_VERSION,
  loadDaemonStates = loadAliveDaemonStates,
  readCommandLineArgs = readProcessCommandLineArgs
} = {}) => {
  const states = await loadDaemonStates()
  const state = states.find(candidate => candidate.pkcRpcUrl && isSamePkcRpcUrl(candidate.pkcRpcUrl, pkcRpcUrl))
  if (!state) {
    return `Using existing bitsocial daemon RPCs. bitsocial-seeder could not verify that daemon's @bitsocial/bitsocial-cli version; keep the external daemon at least v${bundledVersion}, or stop it so the seeder can start its bundled daemon.`
  }

  const args = await readCommandLineArgs(state.pid)
  const daemonVersion = await getBitsocialCliVersionFromCommandLineArgs(args)
  if (!daemonVersion) {
    return `Using existing bitsocial daemon RPCs from PID ${state.pid}. bitsocial-seeder could not verify that daemon's @bitsocial/bitsocial-cli version; keep the external daemon at least v${bundledVersion}, or stop it so the seeder can start its bundled daemon.`
  }

  if (compareVersions(daemonVersion, bundledVersion) < 0) {
    return `Existing bitsocial daemon is running @bitsocial/bitsocial-cli v${daemonVersion}; bitsocial-seeder bundles v${bundledVersion}. Upgrade and restart the external daemon with 'bitsocial update install --restart-daemons', or stop it so the seeder can start its bundled daemon.`
  }
}

export const warnIfExistingDaemonMayBeStale = async ({pkcRpcUrl, logger = console} = {}) => {
  try {
    const warning = await getExistingDaemonVersionWarning({pkcRpcUrl})
    if (warning) {
      logger.warn(warning)
    }
  }
  catch (error) {
    logger.warn(`Using existing bitsocial daemon RPCs. bitsocial-seeder could not verify the external daemon version: ${error?.message || error}`)
  }
}
