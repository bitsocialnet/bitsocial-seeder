import {createRequire} from 'node:module'

const require = createRequire(import.meta.url)
const packageJson = require('../package.json')

export const PACKAGE_NAME = packageJson.name
export const CURRENT_VERSION = packageJson.version
const registryBaseUrl = 'https://registry.npmjs.org'

const normalizeVersion = (version = '') => version.replace(/^v/i, '')

export const compareVersions = (a, b) => {
  const partsA = normalizeVersion(a).split('.')
  const partsB = normalizeVersion(b).split('.')
  const length = Math.max(partsA.length, partsB.length)

  for (let index = 0; index < length; index += 1) {
    const partA = partsA[index] ?? '0'
    const partB = partsB[index] ?? '0'
    const numberA = Number(partA)
    const numberB = Number(partB)
    if (Number.isNaN(numberA) || Number.isNaN(numberB)) {
      if (partA < partB) return -1
      if (partA > partB) return 1
      continue
    }
    if (numberA < numberB) return -1
    if (numberA > numberB) return 1
  }

  return 0
}

export const fetchLatestVersion = async ({
  packageName = PACKAGE_NAME,
  timeoutMs = 5000,
  fetchImpl = fetch
} = {}) => {
  const response = await fetchImpl(`${registryBaseUrl}/${encodeURIComponent(packageName)}/latest`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'bitsocial-seeder'
    },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) {
    throw Error(`npm registry returned ${response.status}`)
  }
  const metadata = await response.json()
  if (typeof metadata.version !== 'string') {
    throw Error('npm registry response did not include a version')
  }
  return metadata.version
}

export const getUpdateMessage = ({
  currentVersion = CURRENT_VERSION,
  latestVersion,
  packageName = PACKAGE_NAME
} = {}) => {
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) {
    return
  }

  return `Update available: v${latestVersion} (current: v${currentVersion}). Run 'npm install -g ${packageName}@latest' to upgrade npm installs, or pull 'ghcr.io/bitsocialnet/bitsocial-seeder:latest' for Docker.`
}

export const checkForUpdate = async ({
  currentVersion = CURRENT_VERSION,
  packageName = PACKAGE_NAME,
  timeoutMs = 5000,
  logger = console,
  fetchImpl = fetch
} = {}) => {
  const latestVersion = await fetchLatestVersion({packageName, timeoutMs, fetchImpl})
  const message = getUpdateMessage({currentVersion, latestVersion, packageName})
  if (message) {
    logger.log(message)
  }
  return {latestVersion, message}
}

// Scheduling is owned by start.js via honker's scheduler; this module just
// exposes the helpers (`checkForUpdate`, `fetchLatestVersion`, etc.) that the
// scheduler worker runs on tick.
