import fs from 'fs'
import config from '../config.js'

// No initial state; the app state is set by importing this file and adding props to this object.
let seederState = {
  communitiesSeeding: undefined // keep undefined until discover-communities.js fetches communities to seed
}
const statePath = config.seederState?.path || 'seederState.json'

// Try to load state from disk on startup.
try {
  seederState = JSON.parse(fs.readFileSync(statePath, 'utf8'))
}
catch (e) {}

export default seederState

// Migrate from the legacy upstream state shape.
if (!seederState.communitiesSeeding && seederState.subplebbitsSeeding) {
  seederState.communitiesSeeding = seederState.subplebbitsSeeding
  delete seederState.subplebbitsSeeding
}

// Save state to disk every 1min.
setInterval(() => {
  if (config.seederState?.writeFile !== false) {
    fs.writeFileSync(statePath, JSON.stringify(seederState, null, 2))
  }
}, 1000 * 60)
