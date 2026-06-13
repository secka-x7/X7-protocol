import { getConfig, setConfig, query } from './db.js'
import { CHAINS } from './config.js'

export function getWinRate(chain, protocol='aave') {
  return Number(getConfig('wr_'+chain+'_'+protocol)||0.4)
}

export function getMinProfit(chain) {
  const base = CHAINS[chain]?.minProfit || 20
  const wr   = getWinRate(chain)
  if (wr > 0.75) return base * 0.7
  if (wr < 0.35) return base * 1.5
  return base
}

export function getBestAssets(chain) {
  return query(
    'SELECT collateral_asset, AVG(profit_usdc) as avg, COUNT(*) as n FROM executions WHERE chain=? AND status=\'success\' GROUP BY collateral_asset ORDER BY avg DESC LIMIT 5',
    [chain]
  )
}

export function updateLearner() {
  const chains    = ['polygon','arbitrum','ethereum','avalanche']
  const protocols = ['aave','compound','morpho']
  for (const c of chains) {
    for (const p of protocols) {
      const rows = query(
        'SELECT COUNT(*) as t, SUM(CASE WHEN status=\'success\' THEN 1 ELSE 0 END) as w FROM executions WHERE chain=? AND protocol=?',
        [c, p]
      )
      if (rows[0]?.t > 0) {
        const wr = rows[0].w / rows[0].t
        setConfig('wr_'+c+'_'+p, wr.toFixed(3))
      }
    }
  }
  console.log('[LEARNER] Win rates updated')
}

export function startLearner() {
  setInterval(updateLearner, 3600000)
  updateLearner()
  console.log('[LEARNER] Pattern learner started')
}
