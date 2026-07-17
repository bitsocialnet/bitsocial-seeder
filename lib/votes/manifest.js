import fs from 'fs'
import path from 'path'
import stripJsonComments from 'strip-json-comments'
import {deriveDirectoryCriteria} from '@bitsocial/pubsub-voting'

// Load directory manifests ({ defaults, contests } shape, JSONC allowed — e.g.
// 5chan-directory-criteria.jsonc) and derive their criteria documents through the library's
// deriveDirectoryCriteria, the SAME helper 5chan derives with. Deriving through anything else
// risks byte-different documents and therefore a forked topic (topic = CID(dag-cbor(criteria))).

const isHttpUrl = (source) => source.startsWith('http://') || source.startsWith('https://')
const isManifestFileName = (name = '') => name.endsWith('.json') || name.endsWith('.jsonc')

const parseManifestText = (text) => JSON.parse(stripJsonComments(text))

export const fetchVotesManifestSource = async (source) => {
  if (!isHttpUrl(source)) {
    const stat = fs.statSync(source)
    if (stat.isDirectory()) {
      const manifests = []
      for (const fileName of fs.readdirSync(source).filter(isManifestFileName)) {
        manifests.push(parseManifestText(fs.readFileSync(path.join(source, fileName), 'utf8')))
      }
      return manifests
    }
    return [parseManifestText(fs.readFileSync(source, 'utf8'))]
  }
  const res = await fetch(source, {headers: {'User-Agent': 'bitsocial-seeder'}})
  if (!res.ok) {
    throw Error(`failed fetching votes manifest source '${source}' got status ${res.status}`)
  }
  return [parseManifestText(await res.text())]
}

// Fetch every configured source and derive its criteria. Like community-list discovery, each
// source is cached by index: a source that fails on this tick keeps serving its last good
// derivation, so a transient manifest outage never drops live contests.
export const loadVotesCriteria = async (sources, cache = []) => {
  const settled = await Promise.allSettled(
    sources.map(async (source) => fetchVotesManifestSource(source).then((manifests) => manifests.flatMap(deriveDirectoryCriteria)))
  )
  for (const [i, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      cache[i] = result.value
    }
    else {
      console.log(`failed loading votes manifest source '${sources[i]}': ${result.reason?.message || result.reason}`)
    }
  }
  return cache.filter(Boolean).flat()
}
