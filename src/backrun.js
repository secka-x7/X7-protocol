// X7 PROTOCOL — ATOMIC BACKRUN ENGINE
// Every large swap on any DEX creates a corrective arbitrage
// We capture that correction in the same block
// Flash loan capital — zero balance needed
// Revenue: fires on every $50K+ swap — multiple times per hour

import { parseAbi, encodeFunctionData, createPublicClient, http } from 'viem'
import { CHAINS, ACTIVE_CHAINS } from './config.js'
import { getConfig, setConfig, recordExecution } from './db.js'
import { getPublicClient } from './pimlico.js'
import { buildAndSubmitBundle } from './flashbots.js'
import WebSocket from 'ws'

const QUOTER_ABI = parseAbi([
  'function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) external returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)'
])

const BACKRUN_ABI = parseAbi([
  'function backrun(address tokenIn,address tokenOut,uint256 amountIn,uint24 buyFee,uint24 sellFee,uint256 minProfit) external'
])

// Uniswap V3 Swap event
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

// Pool addresses to watch per chain — highest volume pools
const WATCHED_POOLS = {
  polygon: [
    '0x45dDa9cb7c25131DF268515131f647d726f50608', // WETH/USDC 0.05%
    '0x50eaEDB835021E4A108B7290636d62E9765cc6d7', // WETH/USDC 0.3%
    '0x847b64f9d3A95e977D157866447a5C0A5dFa0Ee4', // WBTC/WETH
    '0xA374094527e1673A86dE625aa59517c5dE346d32'  // WMATIC/USDC
  ],
  arbitrum: [
    '0xC6962004f452bE9203591991D15f6b388e09E8D0', // WETH/USDC 0.05%
    '0x17c14D2c404D167802b16C450d3c99F88F2c4F4d', // WETH/USDC 0.3%
    '0x2f5e87C9312fa29aed5c179E456625D79015299c'  // WBTC/WETH
  ],
  ethereum: [
    '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640', // USDC/WETH 0.05%
    '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8', // USDC/WETH 0.3%
    '0x4585FE77225b41b697C938B018E2ac67Ac5a20c0', // WBTC/WETH 0.3%
    '0x60594a405d53811d3BC4766596EFD80fd545A270'  // DAI/WETH 0.05%
  ]
}

const SWAP_THRESHOLD_USD = 50000 // Only backrun swaps above $50K

async function findBackrunPath(chainName, tokenIn, tokenOut, amountIn) {
  const chain   = CHAINS[chainName]
  const client  = getPublicClient(chainName)
  const FEE_TIERS = [100, 500, 3000, 10000]

  const quotes = []
  for (const fee of FEE_TIERS) {
    try {
      const [out] = await client.readContract({
        address: chain.quoter, abi: QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [tokenIn, tokenOut, fee, amountIn, 0n]
      })
      if (out) quotes.push({ fee, out })
    } catch {}
    await new Promise(r => setTimeout(r, 20))
  }

  if (quotes.length < 2) return null

  quotes.sort((a, b) => Number(b.out - a.out))
  const best  = quotes[0]
  const worst = quotes[quotes.length - 1]

  const spread = Number(best.out - worst.out) * 10000 / Number(worst.out)
  if (spread < 5) return null // Less than 0.05% spread, not worth it

  const prices   = JSON.parse(getConfig('prices') || '{}')
  const tokenOutSym = tokenOut === chain.usdc ? 'USDC' : 'ETH'
  const price    = tokenOutSym === 'USDC' ? 1 : (prices.ETH || 1800)
  const gasUSD   = chainName === 'ethereum' ? 25 : chainName === 'arbitrum' ? 2 : 0.1
  const profitUSD = (Number(best.out - worst.out) / 1e6) * price - gasUSD

  if (profitUSD < (chainName === 'ethereum' ? 30 : chainName === 'arbitrum' ? 3 : 0.5)) return null

  return { tokenIn, tokenOut, amountIn,
           buyFee: worst.fee, sellFee: best.fee, profitUSD }
}

async function executeBackrun(chainName, opp) {
  const contractAddr = getConfig('contract_' + chainName)
  if (!contractAddr?.startsWith('0x')) return null

  try {
    const minProfit = BigInt(Math.floor(opp.profitUSD * 0.5 * 1e6))
    const data = encodeFunctionData({
      abi: BACKRUN_ABI, functionName: 'backrun',
      args: [opp.tokenIn, opp.tokenOut, opp.amountIn,
             opp.buyFee, opp.sellFee, minProfit]
    })

    const txHash = await buildAndSubmitBundle(chainName, contractAddr, data)
    if (!txHash) return null

    console.log('[BACKRUN] ' + chainName + ': +$' + opp.profitUSD.toFixed(2))

    const total = Number(getConfig('backrun_total') || 0) + opp.profitUSD
    setConfig('backrun_total', total.toFixed(2))
    setConfig('backrun_last',  JSON.stringify({ chain:chainName, profit:opp.profitUSD, ts:Date.now() }))
    setConfig('backrun_count', String(Number(getConfig('backrun_count')||0)+1))

    recordExecution({ txHash, chain:chainName, protocol:'backrun',
      profitUsdc: opp.profitUSD, status:'success' })

    try {
      const { broadcast } = await import('./dashboard.js')
      broadcast('backrun', { chain:chainName, profit:opp.profitUSD, total })
    } catch {}

    return opp.profitUSD
  } catch (e) {
    console.log('[BACKRUN] ' + chainName + ': ' + e.message?.slice(0, 80))
    return null
  }
}

// Watch pool for large swaps via WebSocket
function watchPool(chainName, poolAddr) {
  const chain = CHAINS[chainName]
  if (!chain.rpcWss || chain.rpcWss.includes('demo')) return

  function connect() {
    try {
      const ws = new WebSocket(chain.rpcWss)
      ws.on('open', () => {
        ws.send(JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
          params:  ['logs', { address: poolAddr, topics: [SWAP_TOPIC] }]
        }))
      })

      ws.on('message', async (raw) => {
        try {
          const msg = JSON.parse(raw.toString())
          if (!msg.params?.result?.topics) return

          const log = msg.params.result
          if (log.topics[0] !== SWAP_TOPIC) return

          // Decode amount — simplified check if large enough
          const amount0 = BigInt(log.data?.slice(0, 66) || '0x0')
          const absAmt  = amount0 < 0n ? -amount0 : amount0
          const usdEst  = Number(absAmt) / 1e18 * (JSON.parse(getConfig('prices')||'{}').ETH||1800)

          if (usdEst < SWAP_THRESHOLD_USD) return

          console.log('[BACKRUN] Large swap detected on ' + chainName +
            ' ~$' + usdEst.toFixed(0) + ' — finding backrun path')

          const chain_   = CHAINS[chainName]
          const opp = await findBackrunPath(chainName,
            chain_.usdc, chain_.weth, absAmt)

          if (opp) await executeBackrun(chainName, opp)
        } catch {}
      })

      ws.on('error', () => {})
      ws.on('close', () => setTimeout(connect, 5000))
    } catch { setTimeout(connect, 10000) }
  }
  connect()
}

export function startBackrun() {
  console.log('[BACKRUN] Atomic backrun engine started')
  setConfig('backrun_status', 'active')
  setConfig('backrun_total',  '0')
  setConfig('backrun_count',  '0')

  for (const chainName of ACTIVE_CHAINS) {
    const pools = WATCHED_POOLS[chainName] || []
    pools.forEach(pool => watchPool(chainName, pool))
    if (pools.length > 0) {
      console.log('[BACKRUN] ' + chainName + ': watching ' + pools.length + ' pools')
    }
  }
}

export function getBackrunStatus() {
  return {
    status: getConfig('backrun_status') || 'inactive',
    total:  getConfig('backrun_total')  || '0',
    count:  getConfig('backrun_count')  || '0',
    last:   (() => { try { return JSON.parse(getConfig('backrun_last')||'{}') } catch { return {} } })()
  }
                                   }
