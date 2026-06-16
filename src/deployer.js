// X7 PROTOCOL — DEPLOYER
// Retries every 60 seconds until gas arrives
// The moment 0.01 POL lands in executor wallet:
//   → Deploys automatically, no restart needed
//   → Marks contract address in DB
//   → Engine starts executing liquidations

import { encodeDeployData } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig } from './db.js'
import { getWalletClient, getPublicClient, getExecutorAddress,
         getNativeBalance } from './pimlico.js'
import { compile } from './compiler.js'

// Minimum gas needed per chain to deploy
// These are conservative — actual deployment costs less
const GAS_NEEDED = {
  polygon:   10000000000000000n,  // 0.01 POL  (~$0.007)
  arbitrum:  100000000000000n,    // 0.0001 ETH (~$0.16)
  avalanche: 2000000000000000n,   // 0.002 AVAX (~$0.01)
  ethereum:  3000000000000000n    // 0.003 ETH  (~$5)
}

// Deploy one chain via direct EOA transaction
export async function deployToChain(chainName) {
  // Already deployed — skip
  const existing = getConfig('contract_' + chainName)
  if (existing && existing.startsWith('0x') && existing.length === 42) {
    console.log('[DEPLOY] ' + chainName + ': already at ' + existing)
    return existing
  }

  const chain = CHAINS[chainName]
  if (!chain) return null

  // Check gas balance before attempting
  const balance  = await getNativeBalance(chainName).catch(() => 0n)
  const needed   = GAS_NEEDED[chainName] || 0n
  const execAddr = getExecutorAddress()

  if (balance < needed) {
    const balFloat  = (Number(balance) / 1e18).toFixed(6)
    const needFloat = (Number(needed) / 1e18).toFixed(6)
    console.log('[DEPLOY] ' + chainName +
      ': waiting for gas — have ' + balFloat +
      ' need ' + needFloat +
      ' (' + chain.nativeName + ')' +
      ' → send to ' + execAddr)
    setConfig('live_balance_' + chainName, balFloat)
    return null
  }

  // Compile contract (cached after first compile)
  const artifact = await compile()
  if (!artifact) {
    console.error('[DEPLOY] compile failed')
    return null
  }

  console.log('[DEPLOY] ' + chainName +
    ': gas detected (' +
    (Number(balance) / 1e18).toFixed(6) + ' ' + chain.nativeName +
    ') — deploying X7.sol...')

  setConfig('contract_' + chainName, 'deploying')

  try {
    const wallet  = getWalletClient(chainName)
    const client  = getPublicClient(chainName)

    // Build deployment transaction
    const deployData = encodeDeployData({
      abi:      artifact.abi,
      bytecode: artifact.bytecode,
      args: [
        chain.aavePool || '0x0000000000000000000000000000000000000001',
        chain.router,
        chain.usdc
      ]
    })

    // Send deployment transaction
    const hash = await wallet.sendTransaction({
      data: deployData
      // No 'to' field = contract creation
    })

    console.log('[DEPLOY] ' + chainName + ': tx submitted → ' + hash)

    // Wait for confirmation
    const receipt = await client.waitForTransactionReceipt({
      hash,
      timeout: 120000
    })

    if (receipt.status === 'reverted') {
      throw new Error('deployment transaction reverted')
    }

    const contractAddr = receipt.contractAddress
    if (!contractAddr) {
      throw new Error('no contract address in receipt')
    }

    // Save to DB permanently
    setConfig('contract_' + chainName, contractAddr)
    setConfig('contract_' + chainName + '_block', receipt.blockNumber.toString())
    setConfig('contract_' + chainName + '_ts',    Date.now().toString())

    console.log('[DEPLOY] ' + chainName + ': SUCCESS → ' + contractAddr)
    console.log('[DEPLOY] ' + chainName + ': liquidation engine now active')

    // Import broadcast — notify dashboard
    try {
      const { broadcast } = await import('./dashboard.js')
      broadcast('deploy_success', { chain: chainName, address: contractAddr })
    } catch {}

    return contractAddr

  } catch (e) {
    const msg = (e.message || '').slice(0, 200)
    console.log('[DEPLOY] ' + chainName + ': failed — ' + msg)
    // Reset to null so retry loop tries again
    setConfig('contract_' + chainName, 'failed')
    return null
  }
}

// Deploy all active chains in priority order
// Polygon first — cheapest gas, fastest blocks, most liquidations per hour
export async function deployAll() {
  const order = ['polygon', 'arbitrum', 'avalanche', 'ethereum']
  console.log('[DEPLOY] Starting deployment sequence: ' + order.join(' → '))

  for (const chainName of order) {
    if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) continue
    await deployToChain(chainName).catch(e =>
      console.log('[DEPLOY] ' + chainName + ': ' + (e.message || '').slice(0, 80))
    )
    await new Promise(r => setTimeout(r, 3000))
  }
}

// RETRY LOOP — runs every 60 seconds
// Checks gas balance on every undeployed chain
// Deploys the moment balance is sufficient
// No restart needed when gas arrives
export function startDeployRetryLoop() {
  const order = ['polygon', 'arbitrum', 'avalanche', 'ethereum']

  async function check() {
    for (const chainName of order) {
      if (!CHAINS[chainName]?.active || !ACTIVE_CHAINS.includes(chainName)) continue

      const existing = getConfig('contract_' + chainName)
      // Skip if already deployed
      if (existing && existing.startsWith('0x') && existing.length === 42) continue

      const balance = await getNativeBalance(chainName).catch(() => 0n)
      const needed  = GAS_NEEDED[chainName] || 0n

      setConfig('live_balance_' + chainName, (Number(balance) / 1e18).toFixed(6))

      if (balance >= needed) {
        console.log('[DEPLOY] ' + chainName + ': gas detected in retry loop — deploying')
        await deployToChain(chainName).catch(() => {})
      }
    }
  }

  // Check immediately then every 60 seconds
  check()
  setInterval(check, 60000)
  console.log('[DEPLOY] Retry loop started — checking gas every 60s')
      }
