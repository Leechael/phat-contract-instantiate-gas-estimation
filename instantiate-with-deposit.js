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

  const endpoint = process.env.RPC_ENDPOINT
  if (!endpoint) {
    throw new Error('RPC_ENDPOINT is not set')
  }
  console.log('endpoint: ', endpoint)
  const apiPromise = await ApiPromise.create(options({ provider: new WsProvider(endpoint), noInitWarn: true }))
  const phatRegistry = await OnChainRegistry.create(apiPromise)

  console.log(phatRegistry.clusterInfo.toHuman())
  console.log(phatRegistry.systemContract.address.toString())

  console.log('mnemonic: ', mnemonic)
  console.log('address: ', pair.address)

  // Transfer test PHA, print the mnemonic, address, and balance for debugging
  console.log('claim test pha and wait for block finalized...')
  await signAndSend(apiPromise.tx.balances.transfer(pair.address, 1e12 * 32), alice)

  if (depositToCluster) {
    console.log('trasnfer to cluster and wait for block finalized...')
    await signAndSend(phatRegistry.transferToCluster(pair.address, 1e12 * 30), pair)
    // await new Promise(resolve => setTimeout(resolve, 3_000))
  }

  let before
  {
    const onChainBalance = await apiPromise.query.system.account(pair.address)
    console.log('on chain balance: ', onChainBalance.data.free.toBn().toString(), onChainBalance.data.free.toNumber() / 1e12)
    const clusterBalance = await phatRegistry.getClusterBalance(pair.address)
    console.log('cluster balance: ', clusterBalance.free.toString(), clusterBalance.free.toNumber() / 1e12)
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

  const { gasPrice, depositPerByte, depositPerItem } = phatRegistry.clusterInfo
  console.log('gasPrice', gasPrice.toString(), gasPrice.toNumber())
  console.log('depositPerByte', depositPerByte.toString(), depositPerByte.toNumber() / 1e12)
  console.log('depositPerItem', depositPerItem.toString(), depositPerItem.toNumber() / 1e12)

  // Expectation storage deposit
  const encodedConstructor = blueprintPromise.abi.findConstructor('withCore').toU8a([coreJs, coreSettings, brickProfileAddress])
  const expectedStorageDeposit = depositPerByte.mul(new BN(encodedConstructor.length))
  console.log('calc storageDeposit: ', expectedStorageDeposit, expectedStorageDeposit.toString())
  const depositForEstimate = new BN(expectedStorageDeposit.toNumber() * 1.05)

  const estimateResult = await blueprintPromise.query.withCore(cert.address, { cert, deposit: depositForEstimate }, coreJs, coreSettings, brickProfileAddress)
  console.log(inspect(estimateResult.toHuman(), false, null, true))

  const { gasRequired, storageDeposit } = estimateResult

  console.log('estimate result gasRequired: ', gasRequired.refTime.toBn().toString(), gasRequired.refTime.toNumber() / 1e12)
  console.log('estimate result storageDeposit: ', storageDeposit.isCharge ? storageDeposit.asCharge.toBn().toString() : '', storageDeposit.isCharge ? storageDeposit.asCharge.toBn().toNumber() / 1e12 : '')

  const gasLimit = gasRequired.refTime.toBn().mul(gasPrice)
  console.log('gasLimit: ', gasLimit.toString(), gasLimit.toNumber() / 1e12)
  const storageDepositLimit = storageDeposit.isCharge ? storageDeposit.asCharge.toBn() : new BN(0)
  console.log('storageDepositLimit: ', storageDepositLimit.toString(), storageDepositLimit.toNumber() / 1e12)
  let value = (new BN(0)).add(gasLimit).add(storageDepositLimit)
  // value = new BN(value.toNumber() * 1.05)
  // console.log('value', value.toString(), value.toNumber() / 1e12)
  console.log('auto deposit value: ', value.toString(), value.toNumber() / 1e12)

  const txConf = {
    gasLimit,
    storageDepositLimit,
    deposit: value,
  }
  const result = await signAndSend(blueprintPromise.tx.withCore(txConf, coreJs, coreSettings, brickProfileAddress), pair)
  await result.waitFinalized(10_000) // 10 secs
  console.log('the contract id:', result.contractId.toString())

  // Get the lastest balance.
  {
    const onChainBalance = await apiPromise.query.system.account(pair.address)
    console.log('on chain balance: ', onChainBalance.data.free.toBn().toString())
    const clusterBalance = await phatRegistry.getClusterBalance(pair.address)
    console.log('cluster balance: ', clusterBalance.free.toString())
    console.log('cost', value.sub(clusterBalance.free).toString(), value.sub(clusterBalance.free).toNumber() / 1e12)
  }
}

main().catch(console.error).finally(() => process.exit())
