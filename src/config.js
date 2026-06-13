export const EXEC_KEY  = process.env.EXECUTOR_PRIVATE_KEY || null
export const OWNER_KEY = process.env.OWNER_PRIVATE_KEY    || null

export const CHAINS = {
  polygon: {
    id: 137, gasMethod: 'pimlico',
    rpcHttp: `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POL_KEY||'demo'}`,
    rpcWss:  `wss://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_POL_KEY||'demo'}`,
    pimlico: `https://api.pimlico.io/v2/137/rpc?apikey=${process.env.PIMLICO_API_KEY||''}`,
    aavePool:     '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aaveData:     '0x9441B65EE553F70df9C77d45d3283B6BC24F222d',
    router:       '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:       '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    usdc:   '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    weth:   '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    wbtc:   '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    wmatic: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    link:   '0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39',
    liquidationBonuses: { weth:500, wbtc:1000, usdc:450, wmatic:750, link:750 },
    minProfit: 8, flashFeeBps: 5, active: true
  },
  arbitrum: {
    id: 42161, gasMethod: 'pimlico',
    rpcHttp: `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ARB_KEY||'demo'}`,
    rpcWss:  `wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ARB_KEY||'demo'}`,
    pimlico: `https://api.pimlico.io/v2/42161/rpc?apikey=${process.env.PIMLICO_API_KEY||''}`,
    aavePool:     '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aaveData:     '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
    router:       '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:       '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    usdc:  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    weth:  '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    wbtc:  '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0',
    link:  '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4',
    dai:   '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
    liquidationBonuses: { weth:500, wbtc:1000, usdc:450, link:750, dai:450 },
    minProfit: 15, flashFeeBps: 5, active: true
  },
  ethereum: {
    id: 1, gasMethod: 'flashbots',
    rpcHttp: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY||'demo'}`,
    rpcWss:  `wss://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_ETH_KEY||'demo'}`,
    flashbotsRelay: 'https://relay.flashbots.net',
    aavePool:     '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    aaveData:     '0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3',
    morpho:       '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    router:       '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoter:       '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    wbtc: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    link: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
    dai:  '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    liquidationBonuses: { weth:500, wbtc:1000, usdc:450, link:750, dai:450 },
    minProfit: 60, flashFeeBps: 5, active: true
  },
  avalanche: {
    id: 43114, gasMethod: 'pimlico',
    rpcHttp: `https://avax-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_AVAX_KEY||'demo'}`,
    rpcWss:  `wss://avax-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_AVAX_KEY||'demo'}`,
    pimlico: `https://api.pimlico.io/v2/43114/rpc?apikey=${process.env.PIMLICO_API_KEY||''}`,
    aavePool:     '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    aaveData:     '0x69FA688f1Dc47d4B5d8029D5a35FB7a548310654',
    router:       '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
    quoter:       '0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F',
    usdc:  '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
    weth:  '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
    wavax: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
    wbtc:  '0x50b7545627a5162F82A992c33b87aDc75187B218',
    liquidationBonuses: { weth:500, wbtc:1000, usdc:450, wavax:750 },
    minProfit: 10, flashFeeBps: 5, active: true
  }
}

export const ACTIVE_CHAINS = Object.entries(CHAINS)
  .filter(([,c]) => c.active && !c.rpcHttp.includes('demo'))
  .map(([k]) => k)

export const TOPICS = {
  BORROW:      '0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0',
  LIQUIDATION: '0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286'
}
