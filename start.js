import util from 'util'
util.inspect.defaultOptions.depth = process.env.DEBUG_DEPTH
import dotenv from 'dotenv'
dotenv.config()
import yargs from 'yargs/yargs'
import {hideBin} from 'yargs/helpers'
const argv = yargs(hideBin(process.argv)).argv
console.log({argv})
import config from './config.js'
import {discoverCommunities} from './lib/discover-communities.js'
import {ensureDaemon} from './lib/daemon.js'
import seederState from './lib/seeder-state.js'
import {startUpdateChecks} from './lib/update-check.js'

if (!config?.seeding?.communityListSources?.length) {
  console.log(`missing config.js 'seeding.communityListSources'`)
  process.exit()
}

startUpdateChecks(config.updateCheck)

try {
  await ensureDaemon()
}
catch (error) {
  console.error(error?.message || error)
  process.exit(1)
}

// Discover communities to seed at least once before starting.
discoverCommunities()
while (!seederState.communitiesSeeding) {
  console.log('no communities discovered yet, checking again in 10 seconds...')
  await new Promise(r => setTimeout(r, 10000))
}

const {seedCommunities} = await import('./lib/seed-communities.js')
seedCommunities()
