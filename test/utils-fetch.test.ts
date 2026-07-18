import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fetchCommunityListSource, fetchJson} from '../lib/utils.ts'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-fetch-'))

// Routes the test server understands, keyed by pathname. String responses are
// served as-is (invalid JSON / HTML error pages); everything else is JSON.
let baseUrl: string
const routes: {[pathname: string]: any} = {}
const server = http.createServer((req, res) => {
  const body = routes[req.url || '']
  if (body === undefined) {
    res.statusCode = 404
    return res.end('<html><body>404 Not Found</body></html>')
  }
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
})

test.before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const {port} = server.address() as {port: number}
  baseUrl = `http://127.0.0.1:${port}`
})

test.after(() => {
  server.close()
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

test('loads a community list from a local JSON file', async () => {
  const filePath = path.join(tmpDir, 'local-list.json')
  fs.writeFileSync(filePath, JSON.stringify({communities: [{address: 'local.bso'}]}))

  const list = await fetchCommunityListSource(filePath)
  assert.deepEqual(list, {communities: [{address: 'local.bso'}]})
})

test('loads and merges every JSON file in a local directory', async () => {
  const dirPath = path.join(tmpDir, 'list-dir')
  fs.mkdirSync(dirPath)
  fs.writeFileSync(path.join(dirPath, 'a.json'), JSON.stringify({communities: [{address: 'a.bso'}]}))
  fs.writeFileSync(path.join(dirPath, 'b.json'), JSON.stringify({boards: [{address: 'b.bso', publicKey: 'b-key'}]}))
  fs.writeFileSync(path.join(dirPath, 'notes.txt'), 'not a list')

  const list = await fetchCommunityListSource(dirPath)
  assert.equal(list.title, dirPath)
  assert.deepEqual(
    list.communities.map((community: any) => community.address).sort(),
    ['a.bso', 'b.bso']
  )
})

test('fetches a community list over http', async () => {
  routes['/list.json'] = {communities: [{address: 'remote.bso'}]}

  const list = await fetchCommunityListSource(`${baseUrl}/list.json`)
  assert.deepEqual(list, {communities: [{address: 'remote.bso'}]})
})

test('an html error page fails with the stripped page text, not a JSON parse error', async () => {
  routes['/rate-limited'] = '<html><body><h1>Rate limit exceeded</h1></body></html>'

  await assert.rejects(fetchJson(`${baseUrl}/rate-limited`), (error: any) => {
    assert.match(error.message, /failed fetching got response/)
    assert.match(error.message, /Rate limit exceeded/)
    assert.doesNotMatch(error.message, /<h1>/, 'html tags should be stripped from the error')
    return true
  })

  await assert.rejects(
    fetchCommunityListSource(`${baseUrl}/rate-limited`),
    new RegExp(`failed fetching community list source '${baseUrl}/rate-limited'`)
  )
})

test('a response with no community entries fails loudly', async () => {
  routes['/empty.json'] = {message: 'API rate limit exceeded for 1.2.3.4'}

  await assert.rejects(
    fetchCommunityListSource(`${baseUrl}/empty.json`),
    /failed fetching community list source .* got response '.*API rate limit exceeded/
  )
})

test('a github directory listing fetches nested lists, skipping -defaults.json and tolerating failures', async () => {
  routes['/nested/good.json'] = {communities: [{address: 'nested-good.bso'}]}
  routes['/nested/bad.json'] = '<html><body>500 Server Error</body></html>'
  routes['/listing'] = [
    {type: 'file', name: 'good.json', download_url: `${baseUrl}/nested/good.json`},
    {type: 'file', name: 'bad.json', download_url: `${baseUrl}/nested/bad.json`},
    {type: 'file', name: '5chan-defaults.json', download_url: `${baseUrl}/nested/should-not-be-fetched.json`},
    {type: 'file', name: 'readme.md', download_url: `${baseUrl}/nested/readme.md`},
    {type: 'dir', name: 'subdir'}
  ]

  const list = await fetchCommunityListSource(`${baseUrl}/listing`)
  assert.equal(list.title, `${baseUrl}/listing`)
  assert.deepEqual(list.communities, [{address: 'nested-good.bso', publicKey: undefined}])
})
