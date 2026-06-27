// Watches executor balance on ALL chains every 500ms
// First chain with balance > 0.005 native → triggers deploy immediately
// This IS the primary bootstrap mechanism. Clean. Unbreakable.
import { getActive } from './chains.js'
import { getExecutorAddress } from './pimlico.js'
import { rpcCall } from './rpc.js'
import { emit } from './events.js'
import { getConfig, setConfig } from './db.js'

const _funded    = new Set()
const _lastCheck = {}
let   _interval  = null

async function checkChain(chain) {
  if (_funded.has(chain.name)) return
  const now = Date.now()
  if (now - (_lastCheck[chain.name]||0) < 450) return  // debounce
  _lastCheck[chain.name] = now

  const exec = getExecutorAddress()
  if (!exec) return

  try {
    const hex = await rpcCall(chain.name, 'eth_getBalance', [exec, 'latest'])
    const bal = BigInt(hex || '0x0')
    const min = chain.gasLimit ? chain.gasLimit * 3000000000n : 800000n * 3000000000n
    // min = gas × 3gwei = safe minimum to deploy

    if (bal >= min) {
      _funded.add(chain.name)
      const balEth = Number(bal)/1e18
      console.log(`[BALANCE] ${chain.name} funded: ${balEth.toFixed(6)} ${chain.native}`)
      setConfig('funded_'+chain.name, bal.toString())
      emit('chain_funded', { chain: chain.name, balance: bal, balanceEth: balEth })
    }
  } catch {}
}

export function startBalanceWatcher() {
  console.log('[BALANCE] Watching executor balance on all chains every 500ms')
  console.log('[BALANCE] Send 0.01 native to', getExecutorAddress(), 'on any chain to deploy')

  _interval = setInterval(async () => {
    const chains = getActive()
    // Check all chains in parallel — fast
    await Promise.allSettled(chains.map(checkChain))
  }, 500)

  return _interval
}

export const isFunded    = c => _funded.has(c)
export const getFunded   = () => [..._funded]
export const clearFunded = c => _funded.delete(c)
