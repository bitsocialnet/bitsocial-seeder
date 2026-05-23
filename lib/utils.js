import {stripHtml} from 'string-strip-html'
import fs from 'fs'
import path from 'path'

export const fetchJson = async (url, options) => {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'bitsocial-seeder',
    ...options?.headers
  }
  let textResponse = await fetch(url, {...options, headers}).then((res) => res.text())
  try {
    const json = JSON.parse(textResponse)
    return json
  }
  catch (e) {
    try {
      textResponse = stripHtml(textResponse).result
    }
    catch (e) {}
    throw Error(`failed fetching got response '${textResponse.substring(0, 300).replace(/\s*\n\s*/g, ' ')}'`)
  }
}

const isHttpUrl = (source) => source.startsWith('http://') || source.startsWith('https://')
const isJsonFileName = (name = '') => name.endsWith('.json')

const normalizeCommunityEntry = (entry) => {
  if (!entry || typeof entry !== 'object') {
    return
  }
  const address = typeof entry.address === 'string' ? entry.address.trim() : undefined
  const publicKey = typeof entry.publicKey === 'string' ? entry.publicKey.trim() : undefined
  if (!address && !publicKey) {
    return
  }
  return {
    ...entry,
    address,
    publicKey
  }
}

export const extractCommunityEntries = (list) => {
  const rawEntries = list?.communities || list?.subplebbits || list?.boards || []
  if (!Array.isArray(rawEntries)) {
    return []
  }
  return rawEntries.map(normalizeCommunityEntry).filter(Boolean)
}

const fetchNestedCommunityLists = async (source, entries) => {
  const jsonEntries = entries.filter(entry => entry?.type === 'file' && entry?.download_url && isJsonFileName(entry.name) && !entry.name.endsWith('-defaults.json'))
  const settled = await Promise.allSettled(jsonEntries.map(entry => fetchCommunityListSource(entry.download_url)))
  const communities = []
  for (const [i, result] of settled.entries()) {
    const entry = jsonEntries[i]
    if (result.status === 'fulfilled') {
      communities.push(...extractCommunityEntries(result.value))
    }
    else {
      console.log(`failed fetching community list '${entry.download_url}' from '${source}': ${result.reason}`)
    }
  }
  return {
    title: source,
    communities
  }
}

export const fetchCommunityListSource = async (source) => {
  if (!isHttpUrl(source)) {
    const stat = fs.statSync(source)
    if (stat.isDirectory()) {
      const communities = []
      for (const fileName of fs.readdirSync(source).filter(isJsonFileName)) {
        const filePath = path.join(source, fileName)
        communities.push(...extractCommunityEntries(JSON.parse(fs.readFileSync(filePath, 'utf8'))))
      }
      return {title: source, communities}
    }
    return JSON.parse(fs.readFileSync(source, 'utf8'))
  }

  console.log(`fetching community list source '${source}'`)
  let list
  try {
    list = await fetchJson(source)
  }
  catch (e) {
    throw Error(`failed fetching community list source '${source}': ${e.message}`)
  }

  if (Array.isArray(list) && list.some(entry => entry?.download_url)) {
    return fetchNestedCommunityLists(source, list)
  }

  if (extractCommunityEntries(list).length === 0) {
    throw Error(`failed fetching community list source '${source}' got response '${JSON.stringify(list).substring(0, 300).replace(/\s*\n\s*/g, ' ')}'`)
  }
  return list
}

export const getCommunityKey = (community) => community.publicKey || community.address

export const getCommunityLookup = (community) => {
  const lookup = {}
  if (community.address) {
    lookup.address = community.address
  }
  if (community.publicKey) {
    lookup.publicKey = community.publicKey
  }
  return lookup
}

import TimeAgo from 'javascript-time-ago'
import en from 'javascript-time-ago/locale/en'
TimeAgo.addDefaultLocale(en)
const timeAgo = new TimeAgo('en-US')
export const getTimeAgo = (timestampSeconds) => timestampSeconds ? timeAgo.format(timestampSeconds * 1000) : 'never'
