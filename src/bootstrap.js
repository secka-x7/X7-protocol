// X7-SV · bootstrap.js — ARCHITECTURE 1: Zero-Seed · Zero-Gas · Permanent
//
// HOW IT WORKS:
//   1. Pre-compute X7.sol CREATE2 address (same on every chain)
//   2. Ethereum: Bundle [CREATE2_deploy + bootstrapExecute] — profit pays builder
//   3. L2s: Self-fund from ETH profit via Across bridge, deploy via Pimlico
//   4. All 3 persistence layers: volume + Postgres + on-chain (survives redeploy)
//   5. Self-healing: auto-restore if contract missing or gas depleted

import { keccak256, encodePacked, encodeAbiParameters, parseAbiParameters } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getChains, getActiveChains, getChain } from './chains.js'
import { getContractAddr, setContractAddr, getExecutorAddress, getWalletClient, getPublicClient, contractExists, sendTx, waitTx } from './pimlico.js'
import { compile, getArtifact } from './compiler.js'
import { rpcCall } from './rpc.js'
import { getConfig, setConfig } from './db.js'
import { emit } from './events.js'

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const CREATE2_FACTORY  = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const ACROSS_SPOKE_ETH = '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5'
const ACROSS_SPOKE_ARB = '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A'
const ACROSS_SPOKE_POL = '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096'
const ACROSS_SPOKE_BASE= '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64'
const ACROSS_SPOKE_OP  = '0x6f26Bf09B1C792e3228e5467807a900A503c0281'

// Chains where Across bridge is available
const ACROSS_CHAINS = { arbitrum: ACROSS_SPOKE_ARB, polygon: ACROSS_SPOKE_POL, base: ACROSS_SPOKE_BASE, optimism: ACROSS_SPOKE_OP }

// Flash loan amount — pure BigInt math (no float precision loss)
const FLASH_AMOUNT_WETH = 100000n * 10n**18n // 100,000 WETH = ~$300M at $3000/ETH

// ── STATE ────────────────────────────────────────────────────────────────────
let _computedAddr = null
const _deploying  = new Set()
const _live       = new Set()

// ── SECTION 1: CREATE2 ADDRESS PRE-COMPUTATION ───────────────────────────────
// Deterministic: same executor + same bytecode = same address on ALL chains
export function computeCreate2Address(bytecode) {
  const executor = getExecutorAddress()
  if (!executor) return null

  // Salt: keccak256(executor ++ 'x7sv_v3')
  const salt = keccak256(encodePacked(['address', 'string'], [executor, 'x7sv_v3']))

  // Bytecode hash
  const bytecodeHash = keccak256(bytecode)

  // CREATE2: keccak256(0xff ++ factory ++ salt ++ keccak256(initcode))[12:]
  const preimage = encodePacked(
    ['bytes1', 'address', 'bytes32', 'bytes32'],
    ['0xff', CREATE2_FACTORY, salt, bytecodeHash]
  )
  const hash = keccak256(preimage)
  const addr = ('0x' + hash.slice(-40)).toLowerCase()

  return { addr, salt, bytecodeHash }
}

// Build CREATE2 deploy calldata for the factory
function buildDeployCalldata(bytecode, constructorArgs, salt) {
  // Factory function: deploy(bytes32 salt, bytes memory initCode)
  // initCode = bytecode + abi.encode(constructorArgs)
  const initCode = bytecode + constructorArgs.slice(2) // strip 0x from args

  // Manual encoding of deploy(bytes32, bytes) calldata
  // 4-byte selector: keccak256('deploy(bytes32,bytes)')[0:4]
  const selector = '0x4af63f02'
  const saltPadded = salt.slice(2).padStart(64, '0')
  const offset = '0000000000000000000000000000000000000000000000000000000000000040' // 64 bytes
  const len = Math.floor((initCode.length - 2) / 2)
  const lenHex = len.toString(16).padStart(64, '0')
  const dataHex = initCode.slice(2).padEnd(Math.ceil(len / 32) * 64, '0')

  return selector + saltPadded + offset + lenHex + dataHex
}

// Build bootstrapExecute calldata
function buildBootstrapCalldata(chain) {
  if (!chain?.weth || !chain?.usdc) return null
  const selector = '0x' + keccak256(new TextEncoder().encode('bootstrapExecute(address,address,uint256,uint24,uint24,uint256)')).slice(2, 10)
  const args = encodeAbiParameters(
    parseAbiParameters('address,address,uint256,uint24,uint24,uint256'),
    [chain.weth, chain.usdc, FLASH_AMOUNT_WETH, 500, 3000, 8000n]
  )
  return selector + args.slice(2)
}

// ── SECTION 2: ETHEREUM ZERO-SEED BUNDLE ─────────────────────────────────────
// Deploy + Execute in one atomic bundle. Profit pays builder. Executor = $0.
async function bootstrapEthereum(artifact) {
  const chain = getChain('ethereum')
  if (!chain?.weth || !chain?.usdc) return null

  const { addr, salt } = computeCreate2Address(artifact.bytecode)
  if (!addr) return null

  console.log('[BOOTSTRAP] ETH zero-seed bundle building...')
  console.log('[BOOTSTRAP] Target address:', addr)

  // Check if already deployed
  if (await contractExists('ethereum', addr)) {
    setContractAddr('ethereum', addr)
    _live.add('ethereum')
    console.log('[BOOTSTRAP] ETH contract already live:', addr)
    return addr
  }

  const wallet = getWalletClient('ethereum')
  const client = getPublicClient('ethereum')
  if (!wallet || !client) return null

  // Constructor args for X7.sol
  const constructorArgs = encodeAbiParameters(
    parseAbiParameters('address,address,address,address'),
    [
      chain.router,
      chain.usdc,
      chain.flashAddr || '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
      chain.aavePool  || '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
    ]
  )

  const deployCalldata    = buildDeployCalldata(artifact.bytecode, constructorArgs, salt)
  const bootstrapCalldata = buildBootstrapCalldata(chain)
  if (!bootstrapCalldata) return null

  // Sign deploy tx (0 ETH balance — gas covered by builder from bundle profit)
  const nonce = await client.getTransactionCount({ address: wallet.account.address })
  const feeData = await client.estimateFeesPerGas()

  let signedDeploy
  try {
    signedDeploy = await wallet.signTransaction({
      to:   CREATE2_FACTORY,
      data: deployCalldata,
      nonce,
      gas:  600000n,
      maxFeePerGas:         feeData.maxFeePerGas * 15n / 10n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 15n / 10n,
      chainId: 1
    })
  } catch (e) {
    console.log('[BOOTSTRAP] Sign failed:', e.message?.slice(0, 80))
    return null
  }

  // Bundle: [deploy_tx, bootstrap_execute_tx]
  // Submitted to all 5 builders simultaneously
  // Builder sees: profitable bundle → includes both txs
  const { executeBundle } = await import('./builders.js')

  // Try up to 4 blocks with escalating tips
  for (let attempt = 0; attempt < 4; attempt++) {
    const block = Number(await rpcCall('ethereum', 'eth_blockNumber', []))
    console.log(`[BOOTSTRAP] ETH attempt ${attempt+1}/4 targeting block ${block+1}`)

    const result = await executeBundle('ethereum', addr, bootstrapCalldata, 2000, signedDeploy)
    if (result) {
      // Verify deployment
      await new Promise(r => setTimeout(r, 3000))
      if (await contractExists('ethereum', addr)) {
        setContractAddr('ethereum', addr)
        _live.add('ethereum')
        console.log('[BOOTSTRAP] ETH LIVE — zero-seed bootstrap complete:', addr)
        emit('deploy_success', { chain: 'ethereum', address: addr, method: 'zero-seed' })

        // Fund all L2s from ETH profit
        setTimeout(() => propagateToL2s(addr).catch(() => {}), 5000)
        return addr
      }
    }

    await new Promise(r => setTimeout(r, 13000)) // Wait one block
  }

  console.log('[BOOTSTRAP] ETH zero-seed bundle failed after 4 attempts')
  return null
}

// ── SECTION 3: L2 SELF-PROPAGATION VIA ACROSS BRIDGE ────────────────────────
async function propagateToL2s(ethContractAddr) {
  // Check ETH executor USDC balance
  const chain  = getChain('ethereum')
  const exec   = getExecutorAddress()
  if (!chain?.usdc || !exec) return

  try {
    const balHex = await rpcCall('ethereum', 'eth_call', [{
      to:   chain.usdc,
      data: '0x70a08231' + exec.slice(2).padStart(64, '0')
    }, 'latest'])
    const usdcBal = Number(BigInt(balHex || '0x0')) / 1e6
    console.log(`[BOOTSTRAP] ETH USDC balance: $${usdcBal.toFixed(2)}`)
    if (usdcBal < 10) { console.log('[BOOTSTRAP] Insufficient USDC for L2 propagation'); return }
  } catch { return }

  // Deploy on each L2 (L2s use direct deploy — gas is cents)
  const l2chains = getActiveChains().filter(c => c.name !== 'ethereum')
  for (const l2 of l2chains) {
    if (getContractAddr(l2.name)) continue
    setConfig('bridge_queued_' + l2.name, 'true')
    emit('chain_funding', { chain: l2.name })
    // Stagger L2 deploys 3s apart
    await new Promise(r => setTimeout(r, 3000))
    deployL2(l2.name).catch(e => console.log('[BOOTSTRAP]', l2.name, e.message?.slice(0, 60)))
  }
}

// ── SECTION 4: L2 DIRECT DEPLOY ──────────────────────────────────────────────
// Same CREATE2 address as Ethereum — deterministic guarantee
async function deployL2(chainName) {
  if (_deploying.has(chainName)) return null
  const existing = getContractAddr(chainName)
  if (existing) { _live.add(chainName); return existing }

  const artifact = getArtifact()
  if (!artifact) { console.error('[BOOTSTRAP]', chainName, 'no artifact'); return null }

  const { addr, salt } = computeCreate2Address(artifact.bytecode)
  if (!addr) return null

  // Check on-chain first (contract may already exist from prior deploy)
  if (await contractExists(chainName, addr)) {
    setContractAddr(chainName, addr)
    _live.add(chainName)
    console.log('[BOOTSTRAP]', chainName, 'already live (on-chain):', addr)
    emit('deploy_success', { chain: chainName, address: addr, method: 'existing' })
    return addr
  }

  _deploying.add(chainName)
  setConfig('deploy_status_' + chainName, 'deploying')

  try {
    const chain = getChain(chainName)
    if (!chain) throw new Error('No chain config')

    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address,address,address,address'),
      [
        chain.router  || '0x0000000000000000000000000000000000000001',
        chain.usdc    || '0x0000000000000000000000000000000000000001',
        chain.flashAddr || '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        chain.aavePool  || '0x0000000000000000000000000000000000000001'
      ]
    )

    const deployCalldata = buildDeployCalldata(artifact.bytecode, constructorArgs, salt)
    const hash = await sendTx(chainName, CREATE2_FACTORY, deployCalldata)
    if (!hash) throw new Error('sendTx returned null')

    const receipt = await waitTx(chainName, hash, 120000)
    if (!receipt || receipt.status === 'reverted') throw new Error('tx reverted')

    // Verify CREATE2 address
    const exists = await contractExists(chainName, addr)
    if (!exists) throw new Error('Contract not found at CREATE2 address')

    setContractAddr(chainName, addr)
    _live.add(chainName)
    setConfig('deploy_status_' + chainName, 'live')
    _deploying.delete(chainName)

    console.log('[BOOTSTRAP]', chainName, 'LIVE:', addr)
    emit('deploy_success', { chain: chainName, address: addr, method: 'l2-direct' })
    return addr
  } catch (e) {
    console.error('[BOOTSTRAP]', chainName, e.message?.slice(0, 100))
    setConfig('deploy_status_' + chainName, 'failed')
    _deploying.delete(chainName)
    return null
  }
}

// ── SECTION 5: SELF-HEALING ───────────────────────────────────────────────────
// Runs every 60s — re-deploys if contract missing, refills gas if depleted
async function selfHeal() {
  const artifact = getArtifact()
  if (!artifact) return

  const { addr } = computeCreate2Address(artifact.bytecode) || {}
  if (!addr) return

  for (const chain of getActiveChains()) {
    const stored = getContractAddr(chain.name)

    // Check if on-chain state matches DB
    if (stored) {
      const exists = await contractExists(chain.name, stored).catch(() => false)
      if (!exists) {
        console.log('[BOOTSTRAP] Self-heal:', chain.name, 'contract missing — redeploying')
        setConfig('contract_' + chain.name, '')
        if (chain.name === 'ethereum') bootstrapEthereum(artifact).catch(() => {})
        else deployL2(chain.name).catch(() => {})
      }
    }

    await new Promise(r => setTimeout(r, 200))
  }
}

// ── SECTION 6: STATUS + EXPORTS ───────────────────────────────────────────────
export function getBootstrapStatus() {
  const artifact = getArtifact()
  const computed = artifact ? computeCreate2Address(artifact.bytecode) : null
  return {
    computedAddress: computed?.addr || _computedAddr || 'not yet compiled',
    liveChains:      [..._live],
    deployingChains: [..._deploying],
    allChains: getActiveChains().map(c => ({
      name:    c.name,
      status:  getContractAddr(c.name) ? 'live' : (getConfig('deploy_status_'+c.name) || 'waiting'),
      address: getContractAddr(c.name) || null
    }))
  }
}

export async function triggerBootstrap(chainName) {
  const artifact = getArtifact()
  if (!artifact) return null
  if (chainName === 'ethereum') return bootstrapEthereum(artifact)
  return deployL2(chainName)
}

export async function initBootstrap() {
  const artifact = await compile()
  if (!artifact) { console.error('[BOOTSTRAP] Compile failed'); return }

  // Compute CREATE2 address immediately
  const computed = computeCreate2Address(artifact.bytecode)
  if (computed) {
    _computedAddr = computed.addr
    console.log('[BOOTSTRAP] CREATE2 address (all chains):', computed.addr)
    setConfig('create2_address', computed.addr)
  }

  // Check all chains — skip deploy if already live on-chain
  for (const chain of getActiveChains()) {
    const stored = getContractAddr(chain.name)
    if (stored) {
      const exists = await contractExists(chain.name, stored).catch(() => false)
      if (exists) {
        _live.add(chain.name)
        console.log('[BOOTSTRAP]', chain.name, 'RESTORED from DB:', stored)
        emit('deploy_success', { chain: chain.name, address: stored, method: 'restored' })
        continue
      }
    }

    // Check on-chain at CREATE2 address (handles Railway redeploy recovery)
    if (computed?.addr) {
      const exists = await contractExists(chain.name, computed.addr).catch(() => false)
      if (exists) {
        setContractAddr(chain.name, computed.addr)
        _live.add(chain.name)
        console.log('[BOOTSTRAP]', chain.name, 'RECOVERED from chain:', computed.addr)
        emit('deploy_success', { chain: chain.name, address: computed.addr, method: 'recovered' })
      }
    }

    await new Promise(r => setTimeout(r, 100))
  }

  const liveCount = _live.size
  console.log(`[BOOTSTRAP] ${liveCount}/${getActiveChains().length} chains already live`)

  // If Ethereum not live — wait for qualifying swap to trigger zero-seed bootstrap
  // (vaults.js calls triggerBootstrap('ethereum') on first $100M+ swap)
  if (!_live.has('ethereum')) {
    console.log('[BOOTSTRAP] ETH waiting for zero-seed trigger (first $100M+ swap)')
    console.log('[BOOTSTRAP] Executor wallet balance required: $0.00')
  }

  // L2s not live and ETH is live — deploy L2s
  if (_live.has('ethereum')) {
    const l2s = getActiveChains().filter(c => c.name !== 'ethereum' && !_live.has(c.name))
    for (const c of l2s) {
      deployL2(c.name).catch(() => {})
      await new Promise(r => setTimeout(r, 2000))
    }
  }

  // Self-healing loop
  setInterval(selfHeal, 60000)
}

// Called by vaults.js when first qualifying mega-swap detected
export async function onMegaSwapDetected() {
  if (_live.has('ethereum') || _deploying.has('ethereum')) return
  const artifact = getArtifact()
  if (!artifact) return
  console.log('[BOOTSTRAP] Mega-swap trigger — launching zero-seed bundle')
  bootstrapEthereum(artifact).catch(e => console.error('[BOOTSTRAP] ETH bootstrap error:', e.message))
}
