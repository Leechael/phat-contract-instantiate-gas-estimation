const fs = require('fs')
const { inspect } = require('util')
const { OnChainRegistry, signCertificate, options, PinkBlueprintPromise } = require('@phala/sdk')
const { ApiPromise, Keyring, WsProvider } = require('@polkadot/api')
const { waitReady } = require('@polkadot/wasm-crypto')
const { BN } = require('@polkadot/util')


/**
 * Demo of how to estimate the gas cost & storage deposit fee for instantiate
 */
async function main() {
  const codeHash = '0x96ca5480eb52b8087b1e64cae52c75e6db037e1920320653584ef920db5d29d5'

  await waitReady()
  const keyring = new Keyring({ type: 'sr25519' })
  const pair = keyring.addFromUri('//Alice')
  const cert = await signCertificate({ pair })

  const apiPromise = await ApiPromise.create(options({ provider: new WsProvider('wss://poc6.phala.network/ws'), noInitWarn: true }))
  const phatRegistry = await OnChainRegistry.create(apiPromise)

  // Check the code has been uploaded to the cluster or not. If not, upload it.
  const codeExistsQuery = await phatRegistry.systemContract.query['system::codeExists'](cert.address, { cert }, codeHash, 'Ink')
  if (codeExistsQuery.output.asOk.isFalse) {
    // TODO upload code with PinkCodePromise
  }

  const abi = fs.readFileSync('./artifacts/action_offchain_rollup.contract', 'utf8')

  const blueprintPromise = new PinkBlueprintPromise(apiPromise, phatRegistry, abi, codeHash)

  const coreJs = fs.readFileSync('./artifacts/jscodes/lensapi.js', 'utf8')
  const coreSettings = 'https://api.lens.dev'
  const brickProfileAddress = '3zcnkmF6XjEogm8vAyPiL2ykPZHpeVtcfDcwTWJ2teqdSvjq'

  const estimateResult = await blueprintPromise.query.withCore(cert.address, { cert }, coreJs, coreSettings, brickProfileAddress)
  console.log(inspect(estimateResult.toHuman(), false, null, true))

  const { gasRequired, storageDeposit } = estimateResult

  console.log('gasRequired: ', gasRequired.refTime.toBn().toString())
  console.log('storageDeposit: ', storageDeposit.isCharge ? storageDeposit.asCharge.toBn().toString() : '')

  // Expectation storage deposit:
  const expectedStorageDeposit = phatRegistry.clusterInfo.depositPerByte.mul(new BN(encodedConstructor.length * 2.2))
  console.log('expected storageDeposit: ', expectedStorageDeposit.toString())
}

main().catch(console.error).finally(() => process.exit())
