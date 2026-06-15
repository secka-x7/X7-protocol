// X7 PROTOCOL — EOA TRANSACTION SENDER
// Pure EOA — no paymaster, no ERC-4337
// Bootstrap handles funding. This just sends.

import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon, arbitrum, mainnet, avalanche, base, optimism, bsc, scroll } from 'viem/chains'
import { CHAINS, EXEC_KEY } from './config.js'

const VIEM_CHAINS = {
  polygon, arbitrum, ethereum:mainnet, avalanche,
  base, optimism, bnb:bsc, scroll
}

const _pub = {}, _wal = {}

function account() {
  if (!EXEC_KEY) throw new Error('EXECUTOR_PRIVATE_KEY not set')
  const k = EXEC_KEY.startsWith('0x') ? EXEC_KEY : '0x' + EXEC_KEY
  return privateKeyToAccount(k)
}

export function getPublicClient(chainName) {
  if (!_pub[chainName]) {
    const chain = VIEM_CHAINS[chainName]
    if (!chain) throw new Error('Unknown chain: ' + chainName)
    _pub[chainName] = createPublicClient({ chain, transport: http(CHAINS[chainName].rpcHttp) })
  }
  return _pub[chainName]
}

export function getWalletClient(chainName) {
  if (!_wal[chainName]) {
    const chain = VIEM_CHAINS[chainName]
    if (!chain) throw new Error('Unknown chain: ' + chainName)
    _wal[chainName] = createWalletClient({
      account: account(), chain,
      transport: http(CHAINS[chainName].rpcHttp)
    })
  }
  return _wal[chainName]
}

export async function getNativeBalance(chainName) {
  try {
    return await getPublicClient(chainName).getBalance({ address: getExecutorAddress() })
  } catch { return 0n }
}

export async function getGasPrice(chainName) {
  try {
    const fees = await getPublicClient(chainName).estimateFeesPerGas()
    return fees.maxFeePerGas || fees.gasPrice || 0n
  } catch { return 0n }
}

export async function sendViaPimlico(chainName, to, data, value = 0n) {
  const w = getWalletClient(chainName)
  const c = getPublicClient(chainName)
  const hash = await w.sendTransaction({ to, data, value })
  console.log('[TX] ' + chainName + ' → ' + hash)
  const receipt = await c.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (receipt.status === 'reverted') throw new Error('tx reverted')
  return hash
}

export async function deployContract(chainName, abi, bytecode, args = []) {
  const w = getWalletClient(chainName)
  const c = getPublicClient(chainName)
  const hash = await w.deployContract({ abi, bytecode, args })
  const r    = await c.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (r.status === 'reverted') throw new Error('deploy reverted')
  return r.contractAddress
}

export function getExecutorAddress() {
  try { return account().address } catch { return null }
}

export async function getSmartAddress(chainName) {
  return getExecutorAddress()
      }
