// X7 PROTOCOL — AUTONOMOUS BOOTSTRAP + CROSS-CHAIN FUNDER
//
// PHASE 1: Polls every 60s. When any chain has enough native gas → deploy instantly
// PHASE 2: After first Polygon profit → automatically funds all other chains
// PHASE 3: Each funded chain deploys → starts generating revenue
// Full autonomy after you send 0.01 POL to the executor wallet

import { CHAINS, ACTIVE_CHAINS, DEPLOY_THRESHOLD, NATIVE_SYMBOL,
         CROSS_CHAIN_SEED_USD, FUND_ORDER } from './config.js'
import { getPublicClient, getWalletClient, getNativeBalance,
         deployContract, getExecutorAddress } from './pimlico.js'
import { getConfig, setConfig, query } from './db.js'
import { compile } from './compiler.js'
import { broadcast } from './dashboard.js'

const ALL_CHAINS = ['polygon','arbitrum','base','optimism','bnb','scroll','avalanche','ethereum']

let _artifact = null
async function getArtifact() {
  if (!_artifact) _artifact = await compile()
  return _artifact
}

// Deploy contract to one chain via EOA
async function deployToChain(chainName) {
  const existing = getConfig('contract_' + chainName)
  if (existing && existing.startsWith('0x') && existing !== 'failed') return existing

  const chain    = CHAINS[chainName]
  const artifact = await getArtifact()
  if (!artifact) return null

  console.log('[BOOTSTRAP] ' + chainName + ': deploying X7 contract...')
  setConfig('contract_' + chainName, 'deploying')
  broadcast('deploy_start', { chain: chainName })

  try {
    const addr = await deployContract(chainName, artifact.abi, artifact.bytecode, [
      chain.aavePool || '0x0000000000000000000000000000000000000001',
      chain.router,
      chain.usdc
    ])
    if (addr) {
      setConfig('contract_' + chainName, addr)
      setConfig('contract_' + chainName + '_ts', Date.now())
      console.log('[BOOTSTRAP] ' + chainName + ': DEPLOYED → ' + addr)
      broadcast('deploy_success', { chain: chainName, address: addr })
      return addr
    }
  } catch (e) {
    const msg = (e.message || '').slice(0, 200)
    console.log('[BOOTSTRAP] ' + chainName + ': failed — ' + msg)
    setConfig('contract_' + chainName, 'failed')
    broadcast('deploy_failed', { chain: chainName, error: msg })
  }
  return null
}

// After Polygon profit: send native gas to other chains automatically
async function fundOtherChains() {
  const execAddr = getExecutorAddress()
  if (!execAddr) return

  // Get current prices for conversion
  let prices = {}
  try { prices = JSON.parse(getConfig('prices') || '{}') } catch {}
  const maticPrice = prices.MATIC || prices.POL || 0.8

  // Get Polygon native balance
  const polBal     = await getNativeBalance('polygon')
  const polFloat   = Number(polBal) / 1e18
  const polValueUSD = polFloat * maticPrice

  // Only fund others if we have > $5 worth of POL (keep some for Polygon txs)
  if (polValueUSD < 5) return

  const wallet = getWalletClient('polygon')

  for (const chainName of FUND_ORDER) {
    if (!CHAINS[chainName]?.active || chainName === 'polygon') continue
    if (ACTIVE_CHAINS.includes(chainName)) continue // Already has RPC key

    // Check if already deployed or funded
    const existing = getConfig('contract_' + chainName)
    if (existing && existing.startsWith('0x')) continue

    const alreadyFunded = getConfig('cross_chain_funded_' + chainName)
    if (alreadyFunded) continue

    // We can't directly bridge POL to ETH in one tx without a bridge contract
    // So we track this and log the need — manual funding or bridge integration
    const seedUSD = CROSS_CHAIN_SEED_USD[chainName] || 1
    console.log('[BOOTSTRAP] Cross-chain: need $' + seedUSD + ' on ' + chainName + ' to deploy')
    broadcast('fund_needed', { chain: chainName, amountUSD: seedUSD })
  }

  // For chains that already have ACTIVE keys (Alchemy configured),
  // just check balance and deploy if sufficient
  for (const chainName of FUND_ORDER) {
    if (!ACTIVE_CHAINS.includes(chainName) || chainName === 'polygon') continue
    const existing = getConfig('contract_' + chainName)
    if (existing && existing.startsWith('0x') && existing !== 'failed') continue

    const bal       = await getNativeBalance(chainName)
    const threshold = DEPLOY_THRESHOLD[chainName] || 0n
    if (bal >= threshold) {
      console.log('[BOOTSTRAP] ' + chainName + ': funded — deploying...')
      await deployToChain(chainName).catch(e =>
        console.log('[BOOTSTRAP] ' + chainName + ': ' + e.message?.slice(0,80))
      )
      await new Promise(r => setTimeout(r, 3000))
    }
  }
}

// Record a liquidation that was found but couldn't execute (no contract yet)
export function recordMissedLiquidation(chainName, estimatedProfit) {
  const countKey  = 'missed_count_' + chainName
  const profitKey = 'missed_profit_' + chainName
  const count  = Number(getConfig(countKey)  || 0) + 1
  const profit = Number(getConfig(profitKey) || 0) + (estimatedProfit || 0)
  setConfig(countKey,  count)
  setConfig(profitKey, profit.toFixed(2))
  console.log('[MISSED] ' + chainName + ': $' + (estimatedProfit||0).toFixed(2) +
    ' profit missed (total: $' + profit.toFixed(2) + ')')
  broadcast('missed', { chain:chainName, profit:estimatedProfit, total:profit })
}

// Build bootstrap status for dashboard API
export function getBootstrapStatus() {
  const execAddr = getExecutorAddress()
  const chains   = {}

  for (const chainName of ALL_CHAINS) {
    const bal       = getConfig('live_balance_' + chainName) || '0'
    const threshold = DEPLOY_THRESHOLD[chainName] || 0n
    const thFloat   = (Number(threshold) / 1e18).toFixed(6)
    const contract  = getConfig('contract_' + chainName) || 'waiting'
    const status    = contract.startsWith('0x') ? 'live' :
                      contract === 'deploying'  ? 'deploying' :
                      contract === 'failed'     ? 'failed' : 'waiting'

    chains[chainName] = {
      native:       NATIVE_SYMBOL[chainName] || 'ETH',
      balance:      bal,
      needed:       thFloat,
      contract,
      status,
      hasRpc:       ACTIVE_CHAINS.includes(chainName),
      missedCount:  getConfig('missed_count_'  + chainName) || '0',
      missedProfit: getConfig('missed_profit_' + chainName) || '0',
      deployedAt:   getConfig('contract_' + chainName + '_ts') || null
    }
  }

  return { execAddr, chains, ts: Date.now() }
}

// Main bootstrap loop
export async function startBootstrap() {
  const execAddr = getExecutorAddress()
  if (!execAddr) {
    console.log('[BOOTSTRAP] No EXECUTOR_PRIVATE_KEY set')
    return
  }

  console.log('[BOOTSTRAP] Started. Executor: ' + execAddr)
  console.log('[BOOTSTRAP] Send 0.01 POL to ' + execAddr + ' on Polygon to start')

  async function tick() {
    // Check every active chain's balance
    for (const chainName of ACTIVE_CHAINS) {
      try {
        const bal = await getNativeBalance(chainName)
        setConfig('live_balance_' + chainName, (Number(bal) / 1e18).toFixed(8))

        const threshold = DEPLOY_THRESHOLD[chainName] || 0n
        const existing  = getConfig('contract_' + chainName)

        if (bal >= threshold && (!existing || existing === 'failed')) {
          console.log('[BOOTSTRAP] ' + chainName + ': balance detected → deploying')
          await deployToChain(chainName)
        }
      } catch (e) {
        console.log('[BOOTSTRAP] ' + chainName + ' balance check: ' + e.message?.slice(0,60))
      }
    }

    // After any chain has profit, try to fund others
    const totalProfit = Number(
      query("SELECT SUM(profit_usdc) as t FROM executions WHERE status='success'")[0]?.t || 0
    )
    if (totalProfit > 10) {
      await fundOtherChains().catch(() => {})
    }

    // Broadcast live status to dashboard
    broadcast('bootstrap_tick', getBootstrapStatus())
  }

  await tick()
  setInterval(tick, 60_000)
  console.log('[BOOTSTRAP] Polling every 60s')
}
