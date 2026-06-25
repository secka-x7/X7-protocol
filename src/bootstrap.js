// X7-SV · bootstrap.js — ZERO SEED · ANY CHAIN · PARALLEL RACE
//
// Flow:
//   scanner emits arb_opportunity on ANY chain
//   bootstrap races [CREATE2_deploy + crossPoolArb] bundle
//   builders simulate: profitable → include → contract live → profit swept
//   first chain live → all others deploy via direct tx from swept profit

import {
  keccak256, encodePacked,
  encodeAbiParameters, parseAbiParameters
} from 'viem'
import { getActiveChains, getChain }                         from './chains.js'
import { getContractAddr, setContractAddr,
         getExecutorAddress, getWalletClient, contractExists } from './pimlico.js'
import { compile, getArtifact }                              from './compiler.js'
import { getConfig, setConfig }                              from './db.js'
import { emit, on }                                          from './events.js'
import { rpcCall }                                           from './rpc.js'

const CREATE2_FACTORY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'

// Block times per chain in ms
const BLOCK_MS = {
  ethereum: 12000,
  arbitrum: 300,
  polygon:  2000,
  base:     2000,
  optimism: 2000,
  default:  5000,
}

// Chain IDs
const CHAIN_IDS = {
  ethereum: 1,
  arbitrum: 42161,
  polygon:  137,
  base:     8453,
  optimism: 10,
  avalanche:43114,
  bnb:      56,
  scroll:   534352,
}

// MEV builders per chain
const BUILDERS = {
  ethereum: [
    'https://rpc.titanbuilder.xyz',
    'https://rpc.beaverbuild.org',
    'https://rpc.buildernet.org',
    'https://rsync-builder.xyz',
    'https://relay.flashbots.net',
    'https://mev-share.flashbots.net',
  ],
  arbitrum: ['https://arb1.arbitrum.io/rpc'],
  polygon:  ['https://polygon-rpc.com','https://rpc.ankr.com/polygon'],
  base:     ['https://mainnet.base.org','https://rpc.ankr.com/base'],
  default:  ['https://rpc.ankr.com/eth'],
}

// ── GAS ───────────────────────────────────────────────────────────────────────
const TIPS = [1_500_000_000n, 2_000_000_000n, 3_000_000_000n, 5_000_000_000n]

async function gasParams(chainName, attempt = 0) {
  const tip = TIPS[Math.min(attempt, TIPS.length - 1)]
  try {
    const block   = await rpcCall(chainName, 'eth_getBlockByNumber', ['latest', false])
    const baseFee = BigInt(block?.baseFeePerGas || '0x3b9aca00')
    return { maxFeePerGas: baseFee * 2n + tip, maxPriorityFeePerGas: tip }
  } catch {
    return { maxFeePerGas: tip * 3n, maxPriorityFeePerGas: tip }
  }
}

// ── CREATE2 ───────────────────────────────────────────────────────────────────
let _computed = null  // { addr, salt } — same address on ALL chains

function getComputed(bytecode) {
  if (_computed) return _computed
  const executor = getExecutorAddress()
  if (!executor || !bytecode) return null
  const salt         = keccak256(encodePacked(['address','string'], [executor, 'x7sv_v3']))
  const bytecodeHash = keccak256(bytecode)
  const preimage     = encodePacked(
    ['bytes1','address','bytes32','bytes32'],
    ['0xff', CREATE2_FACTORY, salt, bytecodeHash]
  )
  const addr = ('0x' + keccak256(preimage).slice(-40)).toLowerCase()
  _computed  = { addr, salt }
  return _computed
}

function buildDeployData(bytecode, constructorArgs, salt) {
  const selector   = '0x4af63f02'
  const initCode   = bytecode + constructorArgs.slice(2)
  const saltPadded = salt.slice(2).padStart(64, '0')
  const offset     = '0000000000000000000000000000000000000000000000000000000000000040'
  const len        = Math.floor((initCode.length - 2) / 2)
  const lenHex     = len.toString(16).padStart(64, '0')
  const dataHex    = initCode.slice(2).padEnd(Math.ceil(len / 32) * 64, '0')
  return selector + saltPadded + offset + lenHex + dataHex
}

function buildArbData(opp, contractAddr, executor) {
  const sig = 'crossPoolArb(address,uint256,address,address,address,uint24,uint24,uint256,uint256,address)'
  const sel = keccak256(new TextEncoder().encode(sig)).slice(0, 10)
  const args = encodeAbiParameters(
    parseAbiParameters('address,uint256,address,address,address,uint24,uint24,uint256,uint256,address'),
    [
      opp.flashToken,
      opp.flashAmountWei,
      opp.poolBuy,
      opp.poolSell,
      opp.assetToken,
      opp.buyFee,
      opp.sellFee,
      opp.minBuyAmount,
      opp.minSellUsdc,
      executor
    ]
  )
  return sel + args.slice(2)
}

// ── BUNDLE SUBMIT ─────────────────────────────────────────────────────────────
async function submitBundle(chainName, txs, blockNum) {
  const builders = BUILDERS[chainName] || BUILDERS.default
  const blockHex = '0x' + blockNum.toString(16)

  const results = await Promise.allSettled(
    builders.map(url =>
      fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method:  'eth_sendBundle',
          params:  [{
            txs,
            blockNumber:  blockHex,
            minTimestamp: 0,
            maxTimestamp: Math.floor(Date.now() / 1000) + 120,
          }]
        }),
        signal: AbortSignal.timeout(2000)
      })
      .then(r => r.json())
      .then(d => ({ url, ok: !d.error }))
      .catch(() => ({ url, ok: false }))
    )
  )

  return results
    .filter(r => r.status === 'fulfilled' && r.value.ok)
    .map(r => r.value.url.split('/')[2])
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const _inFlight  = new Set()
const _live      = new Set()
const _deploying = new Set()

// ── BOOTSTRAP A CHAIN ────────────────────────────────────────────────────────
async function bootstrapChain(opp) {
  const { chain } = opp
  if (_live.has(chain))     return
  if (_inFlight.has(chain)) return

  const artifact = getArtifact()
  if (!artifact) { console.error('[BOOTSTRAP] No artifact'); return }

  const computed = getComputed(artifact.bytecode)
  if (!computed) return

  // Already deployed?
  const exists = await contractExists(chain, computed.addr).catch(() => false)
  if (exists) {
    setContractAddr(chain, computed.addr)
    _live.add(chain)
    console.log(`[BOOTSTRAP] ${chain} already live: ${computed.addr}`)
    emit('deploy_success', { chain, address: computed.addr, method: 'existing' })
    onChainLive(chain)
    return
  }

  _inFlight.add(chain)

  const executor = getExecutorAddress()
  const wallet   = getWalletClient(chain)
  const chainCfg = getChain(chain)

  if (!wallet || !chainCfg || !executor) {
    console.error(`[BOOTSTRAP] ${chain}: missing wallet/config`)
    _inFlight.delete(chain)
    return
  }

  console.log(
    `[BOOTSTRAP] ${chain} | gap=${opp.gapPct}% | ` +
    `flash=$${(opp.flashAmountUsdc/1e6).toFixed(1)}M | ` +
    `~$${opp.profitUsdc.toLocaleString()} profit`
  )

  try {
    const chainId = CHAIN_IDS[chain] || 1
    const blockMs = BLOCK_MS[chain]  || BLOCK_MS.default

    // Get nonce + block + gas in parallel
    const [nonceHex, blockHex, gas] = await Promise.all([
      rpcCall(chain, 'eth_getTransactionCount', [executor, 'pending']),
      rpcCall(chain, 'eth_blockNumber', []),
      gasParams(chain, 0)
    ])

    const nonce    = parseInt(nonceHex, 16)
    const blockNum = parseInt(blockHex, 16)

    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address,address,address,address,address'),
      [
        chainCfg.router   || '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
        chainCfg.usdc     || opp.flashToken,
        chainCfg.weth     || opp.assetToken,
        opp.balancer      || '0x0000000000000000000000000000000000000000',
        opp.aave          || '0x0000000000000000000000000000000000000000',
      ]
    )

    const deployData = buildDeployData(artifact.bytecode, constructorArgs, computed.salt)
    const arbData    = buildArbData(opp, computed.addr, executor)

    // Sign both transactions simultaneously
    const [signedDeploy, signedArb] = await Promise.all([
      wallet.signTransaction({
        to: CREATE2_FACTORY, data: deployData,
        nonce,        gas: 600000n, chainId, ...gas
      }),
      wallet.signTransaction({
        to: computed.addr, data: arbData,
        nonce: nonce + 1, gas: 900000n, chainId, ...gas
      })
    ])

    const bundle = [signedDeploy, signedArb]

    // Submit to next 3 blocks simultaneously — max coverage
    const targets = [blockNum + 1, blockNum + 2, blockNum + 3]
    const wins    = (await Promise.all(
      targets.map(b => submitBundle(chain, bundle, b))
    )).flat()

    if (wins.length > 0) {
      console.log(`[BOOTSTRAP] ${chain} accepted by: ${[...new Set(wins)].join(', ')}`)
    } else {
      console.log(`[BOOTSTRAP] ${chain} no builder acceptance — gap may have closed`)
    }

    // Check inclusion with escalating tips across 4 blocks
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise(r => setTimeout(r, blockMs))

      const deployed = await contractExists(chain, computed.addr).catch(() => false)
      if (deployed) {
        setContractAddr(chain, computed.addr)
        _live.add(chain)
        _inFlight.delete(chain)
        console.log(`[BOOTSTRAP] ✓ ${chain.toUpperCase()} LIVE: ${computed.addr}`)
        emit('deploy_success', { chain, address: computed.addr, method: 'bundle-arb' })
        onChainLive(chain)
        return
      }

      // Escalate and resubmit
      if (attempt < 3) {
        const newGas = await gasParams(chain, attempt + 1)
        const tipG   = newGas.maxPriorityFeePerGas / 1_000_000_000n
        console.log(`[BOOTSTRAP] ${chain} escalate → ${tipG}gwei`)
        const [nd, na] = await Promise.all([
          wallet.signTransaction({
            to: CREATE2_FACTORY, data: deployData,
            nonce, gas: 600000n, chainId, ...newGas
          }).catch(() => null),
          wallet.signTransaction({
            to: computed.addr, data: arbData,
            nonce: nonce + 1, gas: 900000n, chainId, ...newGas
          }).catch(() => null)
        ])
        if (nd && na) {
          const nextBlock = blockNum + attempt + 4
          await submitBundle(chain, [nd, na], nextBlock)
        }
      }
    }

    console.log(`[BOOTSTRAP] ${chain} — 4 attempts exhausted, waiting for next gap`)
    _inFlight.delete(chain)

  } catch (e) {
    console.error(`[BOOTSTRAP] ${chain} error:`, e.message?.slice(0, 100))
    _inFlight.delete(chain)
  }
}

// ── AFTER FIRST CHAIN LIVE — CASCADE TO ALL OTHERS ───────────────────────────
function onChainLive(chain) {
  const remaining = getActiveChains().filter(c =>
    !_live.has(c.name) && !_deploying.has(c.name) && c.name !== chain
  )
  console.log(`[BOOTSTRAP] ${chain} live — cascading to ${remaining.length} remaining chains`)
  remaining.forEach((c, i) => {
    setTimeout(() => deployDirect(c.name).catch(() => {}), i * 600)
  })
}

// ── DIRECT DEPLOY (post first chain, we have funds) ───────────────────────────
async function deployDirect(chainName) {
  if (_live.has(chainName) || _deploying.has(chainName)) return
  _deploying.add(chainName)

  const artifact = getArtifact()
  if (!artifact) { _deploying.delete(chainName); return }

  const computed = getComputed(artifact.bytecode)
  if (!computed)  { _deploying.delete(chainName); return }

  const exists = await contractExists(chainName, computed.addr).catch(() => false)
  if (exists) {
    setContractAddr(chainName, computed.addr)
    _live.add(chainName)
    _deploying.delete(chainName)
    emit('deploy_success', { chain: chainName, address: computed.addr, method: 'existing' })
    return
  }

  try {
    const chainCfg = getChain(chainName)
    const executor = getExecutorAddress()
    const wallet   = getWalletClient(chainName)
    if (!wallet || !chainCfg || !executor) throw new Error('missing config')

    const constructorArgs = encodeAbiParameters(
      parseAbiParameters('address,address,address,address,address'),
      [
        chainCfg.router   || '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
        chainCfg.usdc     || '0x0000000000000000000000000000000000000001',
        chainCfg.weth     || '0x0000000000000000000000000000000000000001',
        chainCfg.flashAddr|| '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
        chainCfg.aavePool || '0x0000000000000000000000000000000000000001',
      ]
    )

    const deployData = buildDeployData(artifact.bytecode, constructorArgs, computed.salt)
    const chainId    = CHAIN_IDS[chainName] || 1
    const blockMs    = BLOCK_MS[chainName]  || BLOCK_MS.default

    const [nonceHex, gas] = await Promise.all([
      rpcCall(chainName, 'eth_getTransactionCount', [executor, 'pending']),
      gasParams(chainName, 0)
    ])

    const signed = await wallet.signTransaction({
      to: CREATE2_FACTORY, data: deployData,
      nonce: parseInt(nonceHex, 16),
      gas:   600000n, chainId, ...gas
    })

    const hash = await rpcCall(chainName, 'eth_sendRawTransaction', [signed])
    if (!hash) throw new Error('no tx hash')
    console.log(`[BOOTSTRAP] ${chainName} deploy tx: ${hash.slice(0, 18)}...`)

    // Wait up to 10 blocks
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, blockMs))
      const ok = await contractExists(chainName, computed.addr).catch(() => false)
      if (ok) {
        setContractAddr(chainName, computed.addr)
        _live.add(chainName)
        _deploying.delete(chainName)
        console.log(`[BOOTSTRAP] ✓ ${chainName} LIVE (direct): ${computed.addr}`)
        emit('deploy_success', { chain: chainName, address: computed.addr, method: 'direct' })
        return
      }
    }
    throw new Error('confirmation timeout')

  } catch (e) {
    console.error(`[BOOTSTRAP] ${chainName} direct deploy failed:`, e.message?.slice(0, 80))
    _deploying.delete(chainName)
  }
}

// ── EXPORTS ───────────────────────────────────────────────────────────────────
export function getBootstrapStatus() {
  const artifact = getArtifact()
  const computed = artifact ? getComputed(artifact.bytecode) : null
  return {
    computedAddress: computed?.addr || 'compiling...',
    liveChains:      [..._live],
    inFlightChains:  [..._inFlight],
    deployingChains: [..._deploying],
    allChains: getActiveChains().map(c => ({
      name:    c.name,
      status:  _live.has(c.name)      ? 'live'
             : _inFlight.has(c.name)  ? 'in-flight'
             : _deploying.has(c.name) ? 'deploying'
             : 'waiting',
      address: getContractAddr(c.name) || null
    }))
  }
}

// vaults.js compatibility shim
export async function onMegaSwapDetected() {}

export async function initBootstrap() {
  console.log('[BOOTSTRAP] Initializing — zero seed · all chains · parallel race')

  const artifact = await compile()
  if (!artifact) {
    console.error('[BOOTSTRAP] Compile failed — cannot proceed')
    return
  }

  const computed = getComputed(artifact.bytecode)
  if (computed) {
    setConfig('create2_address', computed.addr)
    console.log('[BOOTSTRAP] CREATE2 address:', computed.addr)
  }

  // Restore already-deployed chains from DB + on-chain check
  let restored = 0
  for (const chain of getActiveChains()) {
    const addr = getContractAddr(chain.name) || computed?.addr
    if (!addr) continue
    const exists = await contractExists(chain.name, addr).catch(() => false)
    if (exists) {
      setContractAddr(chain.name, addr)
      _live.add(chain.name)
      restored++
      console.log(`[BOOTSTRAP] ${chain.name} RESTORED: ${addr}`)
      emit('deploy_success', { chain: chain.name, address: addr, method: 'restored' })
    }
    await new Promise(r => setTimeout(r, 80))
  }

  console.log(`[BOOTSTRAP] ${restored} chains restored | ${getActiveChains().length - restored} waiting`)

  // If some chains are already live, cascade to the rest
  if (_live.size > 0) {
    const remaining = getActiveChains().filter(c => !_live.has(c.name))
    if (remaining.length > 0) {
      console.log(`[BOOTSTRAP] Cascading to ${remaining.length} remaining chains...`)
      remaining.forEach((c, i) => setTimeout(() => deployDirect(c.name).catch(() => {}), i * 600))
    }
  }

  // THE TRIGGER — any gap on any chain fires this
  on('arb_opportunity', opp => {
    if (_live.has(opp.chain)) return
    bootstrapChain(opp).catch(e =>
      console.error(`[BOOTSTRAP] ${opp.chain}:`, e.message?.slice(0, 80))
    )
  })

  console.log('[BOOTSTRAP] Listening for arb_opportunity — first gap on any chain wins')

  // Self-heal every 60s
  setInterval(async () => {
    const artifact = getArtifact()
    if (!artifact) return
    const computed = getComputed(artifact.bytecode)
    if (!computed) return
    for (const chain of getActiveChains()) {
      if (_live.has(chain.name)) continue
      const ok = await contractExists(chain.name, computed.addr).catch(() => false)
      if (ok) {
        setContractAddr(chain.name, computed.addr)
        _live.add(chain.name)
        console.log(`[BOOTSTRAP] ${chain.name} self-healed`)
        emit('deploy_success', { chain: chain.name, address: computed.addr, method: 'healed' })
      }
    }
  }, 60000)
  }
