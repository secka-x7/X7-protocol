// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IBalancerVault {
    function flashLoan(address, address[] calldata, uint256[] calldata, bytes calldata) external;
}

interface IAavePool {
    function flashLoanSimple(address, address, uint256, bytes calldata, uint16) external;
}

interface IRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee;
        address recipient; uint256 amountIn;
        uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external returns (uint256);
}

contract X7 {
    address public immutable owner;
    address public immutable router;
    address public immutable usdc;
    address public immutable balancerVault;
    address public immutable aavePool;
    uint256 public totalProfit;

    event Executed(string sv, uint256 profit, address chain);

    modifier onlyOwner() { require(msg.sender == owner, "X"); _; }

    constructor(address _router, address _usdc, address _balancer, address _aave) {
        owner = msg.sender;
        router = _router;
        usdc = _usdc;
        balancerVault = _balancer;
        aavePool = _aave;
    }

    // ── ZERO-SEED BOOTSTRAP ───────────────────────────────────────────────
    // Called as tx[1] in CREATE2 bootstrap bundle. Flash loan funds itself.
    function bootstrapExecute(
        address tokenIn, address tokenOut,
        uint256 flashAmount, uint24 buyFee, uint24 sellFee,
        uint256 builderTipBps
    ) external {
        if (balancerVault != address(0)) {
            address[] memory tokens = new address[](1);
            tokens[0] = tokenIn;
            uint256[] memory amounts = new uint256[](1);
            amounts[0] = flashAmount;
            IBalancerVault(balancerVault).flashLoan(
                address(this), tokens, amounts,
                abi.encode(tokenOut, buyFee, sellFee, builderTipBps, uint8(0))
            );
        } else {
            IAavePool(aavePool).flashLoanSimple(
                address(this), tokenIn, flashAmount,
                abi.encode(tokenOut, buyFee, sellFee, builderTipBps, uint8(1)),
                0
            );
        }
    }

    // ── BALANCER FLASH CALLBACK ────────────────────────────────────────────
    function receiveFlashLoan(
        address[] calldata tokens, uint256[] calldata amounts,
        uint256[] calldata feeAmounts, bytes calldata userData
    ) external {
        require(msg.sender == balancerVault, "!vault");
        (address tokenOut, uint24 buyFee, uint24 sellFee, uint256 tipBps,) =
            abi.decode(userData, (address, uint24, uint24, uint256, uint8));
        uint256 profit = _arb(tokens[0], tokenOut, amounts[0], buyFee, sellFee);
        IERC20(tokens[0]).transfer(balancerVault, amounts[0] + feeAmounts[0]);
        _payBuilder(tokens[0], profit, tipBps);
        totalProfit += profit;
        emit Executed("bootstrap", profit, address(this));
    }

    // ── AAVE FLASH CALLBACK ────────────────────────────────────────────────
    function executeOperation(
        address asset, uint256 amount, uint256 premium,
        address, bytes calldata params
    ) external returns (bool) {
        require(msg.sender == aavePool, "!aave");
        (address tokenOut, uint24 buyFee, uint24 sellFee, uint256 tipBps,) =
            abi.decode(params, (address, uint24, uint24, uint256, uint8));
        uint256 profit = _arb(asset, tokenOut, amount, buyFee, sellFee);
        IERC20(asset).approve(aavePool, amount + premium);
        _payBuilder(asset, profit, tipBps);
        totalProfit += profit;
        return true;
    }

    // ── CORE ARB ──────────────────────────────────────────────────────────
    function _arb(
        address tokenIn, address tokenOut, uint256 amountIn,
        uint24 buyFee, uint24 sellFee
    ) internal returns (uint256 profit) {
        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).approve(router, amountIn);
        IRouter(router).exactInputSingle(IRouter.ExactInputSingleParams({
            tokenIn: tokenIn, tokenOut: tokenOut, fee: buyFee,
            recipient: address(this), amountIn: amountIn,
            amountOutMinimum: 0, sqrtPriceLimitX96: 0
        }));
        uint256 received = IERC20(tokenOut).balanceOf(address(this)) - before;
        IERC20(tokenOut).approve(router, received);
        uint256 back = IRouter(router).exactInputSingle(IRouter.ExactInputSingleParams({
            tokenIn: tokenOut, tokenOut: tokenIn, fee: sellFee,
            recipient: address(this), amountIn: received,
            amountOutMinimum: amountIn, sqrtPriceLimitX96: 0
        }));
        profit = back > amountIn ? back - amountIn : 0;
    }

    // ── PAY BUILDER (ETH chains) ───────────────────────────────────────────
    function _payBuilder(address token, uint256 profit, uint256 tipBps) internal {
        if (block.chainid != 1 && block.chainid != 42161) return;
        if (profit == 0 || tipBps == 0) return;
        uint256 tip = (profit * tipBps) / 10000;
        // Simplified: on mainnet, coinbase gets ETH converted from profit
        // Full impl: swap USDC→WETH→unwrap→coinbase.transfer
        (bool ok,) = block.coinbase.call{value: 0}("");
        ok; // Acknowledged - full ETH conversion in propellers.js
    }

    // ── SWEEP PROFITS ─────────────────────────────────────────────────────
    function sweep(address[] calldata tokens, address to) external onlyOwner {
        for (uint i = 0; i < tokens.length; i++) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal > 0) IERC20(tokens[i]).transfer(to, bal);
        }
        if (address(this).balance > 0) payable(to).transfer(address(this).balance);
    }

    // ── DIRECT ARB (from propellers, post-deploy) ─────────────────────────
    function dexArb(
        address tokenIn, address tokenOut,
        uint256 flashAmount, uint24 buyFee, uint24 sellFee,
        uint256 minProfit
    ) external onlyOwner {
        uint256 profit = _arb(tokenIn, tokenOut, flashAmount, buyFee, sellFee);
        require(profit >= minProfit, "!profit");
        totalProfit += profit;
        emit Executed("arb", profit, address(this));
    }

    receive() external payable {}
}
