require('dotenv').config()

const fs = require('fs')
const { inspect } = require('util')
const { OnChainRegistry, signCertificate, signAndSend, options, PinkBlueprintPromise } = require('@phala/sdk')
const { ApiPromise, Keyring, WsProvider } = require('@polkadot/api')
const { waitReady } = require('@polkadot/wasm-crypto')
const { mnemonicGenerate } = require('@polkadot/util-crypto')
const { BN } = require('@polkadot/util')


/**
 * Demo of how to estimate the gas cost & storage deposit fee for instantiate
 */
async function main() {
  const codeHash = '0x96ca5480eb52b8087b1e64cae52c75e6db037e1920320653584ef920db5d29d5'

  // runtime flags
  const depositToCluster = process.argv.find(i => i === '--deposit-to-cluster')
  const autoDeposit = process.argv.find(i => i === '--auto-deposit')

  await waitReady()
  const keyring = new Keyring({ type: 'sr25519' })
  // Ensure generated new account each time.
  const mnemonic = mnemonicGenerate(12)
  const pair = keyring.addFromUri(mnemonic)
  const cert = await signCertificate({ pair })
  const alice = keyring.addFromUri('//Alice')

  const endpoint = process.env.RPC_ENDPOINT ?? 'ws://10.0.0.120:19944'
  console.log('endpoint: ', endpoint)
  const apiPromise = await ApiPromise.create(options({ provider: new WsProvider(endpoint), noInitWarn: true }))
  const phatRegistry = await OnChainRegistry.create(apiPromise)

  // Transfer test PHA, print the mnemonic, address, and balance for debugging
  console.log('mnemonic: ', mnemonic)
  console.log('address: ', pair.address)
  //
  console.log('claim test pha and wait for block finalized...')
  await signAndSend(apiPromise.tx.balances.transfer(pair.address, 1e12 * 32), alice)
  // Wait for block finalized.
  await new Promise(resolve => setTimeout(resolve, 10_000))
  //
  if (depositToCluster) {
    console.log('trasnfer to cluster and wait for block finalized...')
    await signAndSend(phatRegistry.transferToCluster(pair.address, 1e12 * 30), pair)
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
  //
  let before
  {
    const onChainBalance = await apiPromise.query.system.account(pair.address)
    console.log('on chain balance: ', onChainBalance.data.free.toBn().toString())
    const clusterBalance = await phatRegistry.getClusterBalance(pair.address)
    console.log('cluster balance: ', clusterBalance.free.toString())
    before = clusterBalance.free
  }

  // Check the code has been uploaded to the cluster or not. If not, upload it.
  const codeExistsQuery = await phatRegistry.systemContract.query['system::codeExists'](pair.address, { cert }, codeHash, 'Ink')
  if (codeExistsQuery.output.asOk.isFalse) {
    // TODO upload code with PinkCodePromise
  }

  const abi = fs.readFileSync('./artifacts/action_offchain_rollup.contract', 'utf8')

  const blueprintPromise = new PinkBlueprintPromise(apiPromise, phatRegistry, abi, codeHash)

  const coreJs = fs.readFileSync('./artifacts/jscodes/lensapi.js', 'utf8')
  const coreSettings = 'https://api.lens.dev'
  const brickProfileAddress = '3zcnkmF6XjEogm8vAyPiL2ykPZHpeVtcfDcwTWJ2teqdSvjq'

  // Expectation storage deposit
  const encodedConstructor = blueprintPromise.abi.findConstructor('withCore').toU8a([coreJs, coreSettings, brickProfileAddress])
  const expectedStorageDeposit = phatRegistry.clusterInfo.depositPerByte.mul(new BN(encodedConstructor.length))
  console.log('calc storageDeposit: ', expectedStorageDeposit, expectedStorageDeposit.toString())
  const depositForEstimate = new BN(expectedStorageDeposit.toNumber() * 1.05)

  const estimateResult = await blueprintPromise.query.withCore(cert.address, { cert, deposit: depositForEstimate }, coreJs, coreSettings, brickProfileAddress)
  console.log(inspect(estimateResult.toHuman(), false, null, true))

  const { gasRequired, storageDeposit } = estimateResult

  console.log('gasRequired: ', gasRequired.refTime.toBn().toString(), gasRequired.refTime.toNumber() / 1e12)
  console.log('storageDeposit: ', storageDeposit.isCharge ? storageDeposit.asCharge.toBn().toString() : '', storageDeposit.isCharge ? storageDeposit.asCharge.toBn().toNumber() / 1e12 : '')

  let value = (new BN(0)).add(gasRequired.refTime.toBn()).add(storageDeposit.isCharge ? storageDeposit.asCharge.toBn() : new BN(0))
  value = new BN(value.toNumber() * 1.05)

  // instantiate with the estimate result from PRuntime
  try {
    const txConf = {
      gasLimit: gasRequired.refTime,
      // FIXME: set storage deposit with estimate result will fail with `StorageDepositLimitExhausted`
      storageDepositLimit: storageDeposit.isCharge ? storageDeposit.asCharge : null,
    }
    if (autoDeposit) {
      console.log('auto deposit value: ', value.toString(), value.toNumber() / 1e12)
      txConf.deposit = value
    }
    const result = await signAndSend(blueprintPromise.tx.withCore(txConf, coreJs, coreSettings, brickProfileAddress), pair)
    await result.waitFinalized(10_000) // 10 secs
    console.log('the contract id:', result.contractId.toString())
  } catch (error) {
    console.log('tx error: ', error.toHuman ? error.toHuman() : error)
  }

  // Get the lastest balance.
  {
    const onChainBalance = await apiPromise.query.system.account(pair.address)
    console.log('on chain balance: ', onChainBalance.data.free.toBn().toString())
    const clusterBalance = await phatRegistry.getClusterBalance(pair.address)
    console.log('cluster balance: ', clusterBalance.free.toString())
    if (autoDeposit) {
      console.log('cost', value.sub(clusterBalance.free).toString(), value.sub(clusterBalance.free).toNumber() / 1e12)
    } else {
      console.log('cost', before.sub(clusterBalance.free).toString(), before.sub(clusterBalance.free).toNumber() / 1e12)
    }
  }
}

main().catch(console.error).finally(() => process.exit())
