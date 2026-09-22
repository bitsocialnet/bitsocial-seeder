import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import test from 'node:test'

const fixtures = {"tarGz": "H4sIAMRMsmoC/+3NQQrCMBBG4Vl7CskBdFJCFt4mlCC0NA1NXIl3b6wbcS2C9H2bN/ybyaEfwzWe86unocxJvkwb79zW5rOq3dv93K311stR5QdupYalvZd9upsUpmgupsZSzeMgAAAAAAAAAAAAAAAAAIC/sAJeHglWACgAAA==", "escapeTarGz": "H4sIAMRMsmoC/+3RPQ6CQBCA0T0KJ+BPIuch7hY2YlyI13dDiTUa43vNTDeTfClfpnsKh2qL8zBss9jP971rx1Mbqr6um3ld8jUe+OCal+lRzof/lLb+zfy8pfi9/uO+fz90ofpIE/1L/xgAAAAAAAAAAIDf8wJCTiJgACgAAA==", "zip": "UEsDBBQAAAAIAOhcNl0ktxqTDQAAAA8AAAAQAAAAd2VidWkvaW5kZXguaHRtbLPJKMnNscvPttEHMwBQSwECFAMUAAAACADoXDZdJLcakw0AAAAPAAAAEAAAAAAAAAAAAAAAgAEAAAAAd2VidWkvaW5kZXguaHRtbFBLBQYAAAAAAQABAD4AAAA7AAAAAAA="}

// Resolve exactly as the CLI does; the override must preserve its ESM default import.
const cliRequire = createRequire(import.meta.resolve('@bitsocial/bitsocial-cli/package.json'))
const {default: decompress} = await import(pathToFileURL(cliRequire.resolve('decompress')).href)

test('patched archive extractor supports CLI tarball/zip flows and rejects escaping links', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeder-extract-'))
  try {
    const archive = path.join(dir, 'package.tgz')
    fs.writeFileSync(archive, Buffer.from(fixtures.tarGz, 'base64'))
    await decompress(archive, path.join(dir, 'update'), {strip: 1})
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'update/package.json'), 'utf8')).name, 'test')
    await decompress(archive, path.join(dir, 'challenge'))
    assert.ok(fs.existsSync(path.join(dir, 'challenge/package/package.json')))
    await decompress(Buffer.from(fixtures.zip, 'base64'), path.join(dir, 'webuis'))
    assert.equal(fs.readFileSync(path.join(dir, 'webuis/webui/index.html'), 'utf8'), '<html>ok</html>')
    fs.mkdirSync(path.join(dir, 'outside'))
    await assert.rejects(decompress(Buffer.from(fixtures.escapeTarGz, 'base64'), path.join(dir, 'malicious')))
    assert.equal(fs.existsSync(path.join(dir, 'outside/owned')), false)
  }
  finally { fs.rmSync(dir, {recursive: true, force: true}) }
})

test('patched image-size remains compatible with Metro image asset sizing', () => {
  const require = createRequire(import.meta.url)
  const {getAssetSize} = require('metro/private/Assets')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR5kAAAAASUVORK5CYII=', 'base64')
  assert.deepEqual(getAssetSize('png', png, 'image.png'), {width: 1, height: 1})
})
