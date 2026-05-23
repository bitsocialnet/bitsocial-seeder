import util from 'util'
util.inspect.defaultOptions.depth = process.env.DEBUG_DEPTH
import dotenv from 'dotenv'
dotenv.config()
import yargs from 'yargs/yargs'
import {hideBin} from 'yargs/helpers'
const argv = yargs(hideBin(process.argv)).argv
console.log({argv})
import config from './config.js'
import seederState from './lib/seeder-state.js'
import {discoverCommunities} from './lib/discover-communities.js'
import {seedCommunities} from './lib/seed-communities.js'

if (!config?.seeding?.communityListSources?.length) {
  console.log(`missing config.js 'seeding.communityListSources'`)
  process.exit()
}

// Discover communities to seed at least once before starting.
discoverCommunities()
while (!seederState.communitiesSeeding) {
  console.log('no communities discovered yet, checking again in 10 seconds...')
  await new Promise(r => setTimeout(r, 10000))
}

seedCommunities()
