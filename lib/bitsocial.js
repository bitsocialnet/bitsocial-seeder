import config from '../config.js'
const pubsubKuboRpcUrl = config.pubsubKuboRpcUrl || config.kuboRpcUrl
import {create as createKubo} from 'kubo-rpc-client'
import {Agent as HttpsAgent} from 'https'
import {Agent as HttpAgent} from 'http'
import PKC from '@pkcprotocol/pkc-js'

const pkc = await PKC({
  pkcRpcClientsOptions: [config.pkcRpcUrl]
})
pkc.on('error', error => {
  console.log(`pkc rpc error: ${error?.message || error}`)
})

const Agent = config.kuboRpcUrl?.startsWith('https') ? HttpsAgent : HttpAgent
const kubo = await createKubo({
  url: config.kuboRpcUrl,
  agent: new Agent({keepAlive: true, maxSockets: Infinity})
})
const kuboPubsub = await createKubo({
  url: pubsubKuboRpcUrl,
  agent: new Agent({keepAlive: true, maxSockets: Infinity})
})

export {
  kubo,
  kuboPubsub,
  pkc,
  pubsubKuboRpcUrl
}
