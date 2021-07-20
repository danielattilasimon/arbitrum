import * as ethers from 'ethers'
import { Inbox__factory } from 'arb-ts'
import { ValidatorWalletCreator__factory } from 'arb-ts/dist/lib/abi/factories/ValidatorWalletCreator__factory'
import * as yargs from 'yargs'
import * as fs from 'fs-extra'
import { setupValidatorStates } from './setup_validators'

import * as addresses from '../../arb-bridge-eth/bridge_eth_addresses.json'
import { execSync } from 'child_process'

const provider = new ethers.providers.JsonRpcProvider('http://localhost:7545')

const wallet = provider.getSigner(0)
const root = '../../'
const rollupsPath = root + 'rollups/'

const clientWallets = [
  '0x979f020f6f6f71577c09db93ba944c89945f10fade64cfc7eb26137d5816fb76',
  '0xd26a199ae5b6bed1992439d1840f7cb400d0a55a0c9f796fa67d7c571fbb180e',
  '0xaf5c2984cb1e2f668ae3fd5bbfe0471f68417efd012493538dcd42692299155b',
  '0x9af1e691e3db692cc9cad4e87b6490e099eb291e3b434a0d3f014dfd2bb747cc',
  '0x27e926925fb5903ee038c894d9880f74d3dd6518e23ab5e5651de93327c7dffa',
].map(key => new ethers.Wallet(key).connect(provider))

const clientAddresses = clientWallets.map(wallet => wallet.address)

export interface RollupCreatedEvent {
  rollupAddress: string
  inboxAddress: string
}

async function setupRollup(
  sequencerAddress: string,
  whitelistAddresses?: string[]
): Promise<RollupCreatedEvent> {
  // TODO: is the L2 sequencer the 1st unlocked account in the L1 node?
  const network = 'local_development'

  execSync(
    'yarn workspace arb-bridge-eth hardhat create-chain ' +
      `--sequencer ${sequencerAddress} ` +
      (whitelistAddresses
        ? `--whitelist ${whitelistAddresses.join(',')} `
        : '') +
      `--network ${network}`
  )

  const fileName = `rollup-${network}.json`
  const file = fs.readFileSync(`../arb-bridge-eth/${fileName}`).toString()
  const ev = JSON.parse(file)

  return {
    rollupAddress: ev.rollupAddress,
    inboxAddress: ev.inboxAddress,
  }
}

async function initializeWallets(count: number): Promise<ethers.Wallet[]> {
  const wallets: ethers.Wallet[] = []
  const waits = []
  for (let i = 0; i < count; i++) {
    const newWallet = ethers.Wallet.createRandom().connect(provider)
    const tx = {
      to: newWallet.address,
      value: ethers.utils.parseEther('5.0'),
    }
    const send = await wallet.sendTransaction(tx)
    wallets.push(newWallet)
    waits.push(send.wait())
  }
  await Promise.all(waits)
  return wallets
}

async function initializeClientWallets(
  inboxAddress: string,
  clientWallets: ethers.Wallet[]
): Promise<void> {
  const amount = ethers.utils.parseEther('100')

  for (const clientWallet of clientWallets) {
    const sendTx = await wallet.sendTransaction({
      to: clientWallet.address,
      value: amount,
    })
    await sendTx.wait()

    const inbox = Inbox__factory.connect(inboxAddress, clientWallet)
    const depositTx = await inbox.depositEth(0, { value: amount })
    await depositTx.wait()
  }
}

async function setupValidators(
  count: number,
  blocktime: number,
  force: boolean
): Promise<void> {
  const wallets = await initializeWallets(count)
  const { rollupAddress, inboxAddress } = await setupRollup(
    wallets[0].address,
    clientAddresses
  )
  console.log('Created rollup', rollupAddress)

  const validatorsPath = rollupsPath + 'local/'

  if (count < 2) {
    throw Error('must create at least 1 validator')
  }

  if (!fs.existsSync(rollupsPath)) {
    fs.mkdirSync(rollupsPath)
  }

  if (fs.existsSync(validatorsPath)) {
    if (force) {
      fs.removeSync(validatorsPath)
    } else {
      throw Error(
        `${validatorsPath} already exists. First manually delete it or run with --force`
      )
    }
  }

  const config = {
    rollup_address: rollupAddress,
    inbox_address: inboxAddress,
    validator_utils_address: addresses['contracts']['ValidatorUtils'].address,
    validator_wallet_factory_address:
      addresses['contracts']['ValidatorWalletCreator'].address,
    bridge_utils_address: addresses['contracts']['BridgeUtils'].address,
    eth_url: 'http://localhost:7545',
    password: 'pass',
    blocktime: blocktime,
  }

  await setupValidatorStates(count, 'local', config)

  const validatorWalletAddresses = []
  let i = 0
  for (const wallet of wallets) {
    const valPath = validatorsPath + 'validator' + i + '/'
    const walletPath = valPath + 'wallets/'
    fs.mkdirSync(walletPath)
    const encryptedWallet = await wallet.encrypt('pass')
    fs.writeFileSync(walletPath + wallet.address, encryptedWallet)

    if (i > 0) {
      const validatorWalletCreator = ValidatorWalletCreator__factory.connect(
        addresses['contracts']['ValidatorWalletCreator'].address,
        wallets[i]
      )

      const tx = await validatorWalletCreator.createWallet()
      const receipt = await tx.wait()

      const ev = validatorWalletCreator.interface.parseLog(
        receipt.logs[receipt.logs.length - 1]
      )

      validatorWalletAddresses.push(ev.args[0])

      fs.writeFileSync(
        valPath + 'chainState.json',
        JSON.stringify({
          validatorWallet: ev.args[0],
        })
      )
    }

    i++
  }

  execSync(
    `yarn workspace arb-bridge-eth hardhat whitelist-validators ${rollupAddress} ` +
      validatorWalletAddresses.join(',')
  )

  await initializeClientWallets(inboxAddress, clientWallets)
}

if (require.main === module) {
  yargs.command(
    'init [rollup] [ethurl]',
    'initialize validators for the given rollup chain',
    yargsBuilder =>
      yargsBuilder.options({
        force: {
          description: 'clear any existing state',
          type: 'boolean',
          default: false,
        },
        validatorcount: {
          description: 'number of validators to deploy',
          default: 1,
        },
        blocktime: {
          description: 'expected length of time between blocks',
          default: 2,
        },
      }),
    args => {
      setupValidators(args.validatorcount + 1, args.blocktime, args.force)
    }
  ).argv
}
