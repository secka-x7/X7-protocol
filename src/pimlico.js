    // X7 PROTOCOL — PIMLICO ERC-4337
// Uses permissionless SDK properly:
//   SimpleSmartAccount owned by EXECUTOR_PRIVATE_KEY
//   Pimlico ERC-20 paymaster — USDC pays gas, zero native token ever needed
//   EntryPoint v0.7 (permissionless 0.2.x default)
//
// Flow per tx:
//   1. createPimlicoClient  → bundler + paymaster RPC
//   2. toSimpleSmartAccount → deterministic smart account from EOA key
//   3. createSmartAccountClient → viem-compatible client that signs + submits UserOps
//   4. client.sendTransaction → encodes as UserOp, gets paymaster USDC quote, signs, submits
//
// Fallback: if Pimlico key missing → sendDirect() (EOA needs native gas)

import {
  createPublicClient,
  createWalletClient,
  http
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon, arbitrum, base, mainnet, avalanche } from 'viem/chains'
import { createSmartAccountClient } from 'permissionless'
import { toSimpleSmartAccount } from 'permissionless/accounts'
import { createPimlicoClient } from 'permissionless/clients/pimlico'
import { entryPoint07Address } from 'viem/account-abstraction'
import { CHAINS, EXEC_KEY } from './config.js'
import { getConfig, setConfig } from './db.js'

const VIEM_CHAINS = { polygon, arbitrum, base, ethereum: mainnet, avalanche }

// Cache: one smart account client per chain
const _publicClients  = {}
const _walletClients  = {}
const _smartClients   = {}   // createSmartAccountClient instances
const _smartAddresses = {}   // resolved smart account addresses

function getAccount() {
  if (!EXEC_KEY) throw new Error('EXECUTOR_PRIVATE_KEY not set')
  const k = EXEC_KEY.startsWith('0x') ? EXEC_KEY : '0x' + EXEC_KEY
  return privateKeyToAccount(k)
}

export function getPublicClient(chainName) {
  if (!_publicClients[chainName]) {
    _publicClients[chainName] = createPublicClient({
      chain:     VIEM_CHAINS[chainName],
      transport: http(CHAINS[chainName].rpcHttp)
    })
  }
  return _publicClients[chainName]
}

export function getWalletClient(chainName) {
  if (!_walletClients[chainName]) {
    _walletClients[chainName] = createWalletClient({
      account:   getAccount(),
      chain:     VIEM_CHAINS[chainName],
      transport: http(CHAINS[chainName].rpcHttp)
    })
  }
  return _walletClients[chainName]
}

// Build a Pimlico smart account client with ERC-20 USDC paymaster
// Returns null if PIMLICO_API_KEY is not set
async function getSmartClient(chainName) {
  if (_smartClients[chainName]) return _smartClients[chainName]

  const chain = CHAINS[chainName]
  const pimlicoUrl = chain.pimlico
  // pimlico url ends with apikey= if key is missing
  if (!pimlicoUrl || pimlicoUrl.endsWith('apikey=')) return null

  const publicClient = getPublicClient(chainName)
  const account      = getAccount()

  // Step 1: Build smart account (SimpleAccount v0.7, deterministic from EOA)
  const smartAccount = await toSimpleSmartAccount({
    client:     publicClient,
    owner:      account,
    entryPoint: { address: entryPoint07Address, version: '0.7' }
  })

  // Cache the smart account address
  _smartAddresses[chainName] = smartAccount.address
  setConfig(`smart_addr_${chainName}`, smartAccount.address)

  // Step 2: Pimlico client handles bundler + paymaster RPC
  const pimlicoClient = createPimlicoClient({
    transport: http(pimlicoUrl),
    chain:     VIEM_CHAINS[chainName],
    entryPoint: { address: entryPoint07Address, version: '0.7' }
  })

  // Step 3: Smart account client — wraps everything into a standard viem client
  // paymasterContext tells Pimlico to charge gas in USDC (ERC-20 paymaster)
  const smartClient = createSmartAccountClient({
    account:      smartAccount,
    chain:        VIEM_CHAINS[chainName],
    bundlerTransport: http(pimlicoUrl),
    paymaster:    pimlicoClient,
    paymasterContext: {
      token: chain.usdc   // ← this is the entire paymaster config: pay gas in USDC
    }
  })

  _smartClients[chainName] = smartClient
  console.log(`[PIMLICO] ${chainName}: smart account = ${smartAccount.address}`)
  return smartClient
}

// Main send function — used by executor.js, deployer.js, yield.js
// Tries ERC-4337 path first, falls back to direct EOA tx
export async function sendViaPimlico(chainName, to, data, value = 0n) {
  try {
    const smartClient = await getSmartClient(chainName)

    if (smartClient) {
      // ERC-4337 path — gas paid in USDC, zero MATIC/ETH needed
      const txHash = await smartClient.sendTransaction({ to, data, value })
      console.log(`[PIMLICO] ${chainName}: UserOp sent → ${txHash}`)
      return txHash
    }
  } catch (e) {
    console.log(`[PIMLICO] ${chainName}: ERC-4337 failed (${e.message?.slice(0, 100)}) — falling back to direct`)
  }

  // Fallback: direct EOA tx — requires native gas in wallet
  return sendDirect(chainName, to, data, value)
}

// Direct EOA transaction — only used as fallback
async function sendDirect(chainName, to, data, value = 0n) {
  const wallet = getWalletClient(chainName)
  const client = getPublicClient(chainName)
  const hash   = await wallet.sendTransaction({ to, data, value })
  await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
  return hash
}

// Deploy contract — always uses EOA direct tx (one-time cost, fine)
export async function deployContract(chainName, abi, bytecode, args = []) {
  const wallet = getWalletClient(chainName)
  const client = getPublicClient(chainName)
  const hash   = await wallet.deployContract({ abi, bytecode, args })
  const r      = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
  return r.contractAddress
}

// Returns the smart account address if initialised, else EOA address
export function getExecutorAddress() {
  try {
    // Return EOA address — used for profit balance checks
    return getAccount().address
  } catch {
    return null
  }
}

// Returns smart account address for a chain (initialised lazily)
export async function getSmartAddress(chainName) {
  if (_smartAddresses[chainName]) return _smartAddresses[chainName]
  const cached = getConfig(`smart_addr_${chainName}`)
  if (cached) { _smartAddresses[chainName] = cached; return cached }
  // Force init to get address
  await getSmartClient(chainName).catch(() => {})
  return _smartAddresses[chainName] || getAccount().address
}
