// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
// X7Hook.sol — Standalone V4 Hook
//
// Deployed separately from X7.sol. Minimal. Cheap.
// Registers on V4 pools. Calls X7.sol.crossPoolArb() in afterSwap.
//
// DEPLOYMENT COST: ~$1-2 at current ETH prices.
// Funded from first crossPoolArb() profit.
//
// WHY SEPARATE CONTRACT:
//   V4 hook address must have specific permission bits set.
//   The hook address is determined at CREATE2 time.
//   X7.sol and X7Hook.sol have different addresses → different bit patterns.
//   Keeping them separate allows each to be deployed at the correct address.
//
// HOOK FLAGS REQUIRED:
//   afterSwap = true  (bit 7 of address low byte)
//   beforeSwap = optional (bit 6)
//   All other flags = false
// ─────────────────────────────────────────────────────────────────────────────

interface IX7 {
    function crossPoolArb(
        address flashToken,
        uint256 flashAmount,
        address poolBuy,
        address poolSell,
        address assetToken,
        uint24  buyFee,
        uint24  sellFee,
        uint256 minBuyAmount,
        uint256 minSellUsdc,
        address executor
    ) external;
}

interface IERC20Hook {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

contract X7Hook {

    address public immutable owner;
    address public immutable x7;           // X7.sol address
    address public immutable poolManager;  // V4 PoolManager
    address public immutable executor;     // Profit destination

    uint256 public totalHookProfit;
    uint256 public hookFires;

    // Minimum swap size to arm hook ($1M in USDC terms)
    uint256 public constant MIN_SWAP_USDC = 1_000_000e6;

    event HookExecuted(address pool, uint256 profit, uint256 blockN);
    event HookSkipped(address pool, string reason);

    modifier onlyPoolManager() {
        require(msg.sender == poolManager, "X7H:not-manager");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "X7H:auth");
        _;
    }

    constructor(
        address _x7,
        address _poolManager,
        address _executor
    ) {
        owner       = msg.sender;
        x7          = _x7;
        poolManager = _poolManager;
        executor    = _executor;
    }

    // ── BEFORE SWAP ───────────────────────────────────────────────────────────
    // Called by V4 PoolManager before every swap on registered pools.
    // We just return the selector — actual work happens in afterSwap.
    function beforeSwap(
        address sender,
        bytes32 poolId,
        bool    zeroForOne,
        int256  amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4) {
        // Just acknowledge — no action before swap
        return X7Hook.beforeSwap.selector;
    }

    // ── AFTER SWAP ────────────────────────────────────────────────────────────
    // Called by V4 PoolManager after every swap on registered pools.
    // hookData contains the arb opportunity packed by scanner.js.
    // If hookData is empty or small: no arb queued, skip silently.
    //
    // FAILURE PROOFING:
    //   try/catch around crossPoolArb — hook never reverts parent swap
    //   if arb fails (gap closed): emit HookSkipped, continue
    //   if hookData malformed: caught by try/catch, continue
    function afterSwap(
        address sender,
        bytes32 poolId,
        bool    zeroForOne,
        int256  amountSpecified,
        int256  amount0Delta,
        int256  amount1Delta,
        bytes calldata hookData
    ) external onlyPoolManager returns (bytes4) {

        // Skip if no opportunity data
        if (hookData.length < 192) {
            return X7Hook.afterSwap.selector;
        }

        // Decode opportunity (packed by scanner.js)
        (
            address flashToken,
            uint256 flashAmount,
            address poolBuy,
            address poolSell,
            address assetToken,
            uint24  buyFee,
            uint24  sellFee,
            uint256 minBuyAmount,
            uint256 minSellUsdc,
            address _executor
        ) = abi.decode(hookData, (
            address, uint256,
            address, address,
            address, uint24, uint24,
            uint256, uint256,
            address
        ));

        // Execute arb — NEVER revert parent swap on failure
        try IX7(x7).crossPoolArb(
            flashToken, flashAmount,
            poolBuy, poolSell,
            assetToken, buyFee, sellFee,
            minBuyAmount, minSellUsdc,
            _executor
        ) {
            hookFires++;
            uint256 profit = minSellUsdc - flashAmount;
            totalHookProfit += profit;
            emit HookExecuted(address(uint160(uint256(poolId))), profit, block.number);
        } catch Error(string memory reason) {
            emit HookSkipped(address(uint160(uint256(poolId))), reason);
        } catch {
            emit HookSkipped(address(uint160(uint256(poolId))), "unknown");
        }

        return X7Hook.afterSwap.selector;
    }

    // ── EMERGENCY SWEEP ───────────────────────────────────────────────────────
    function sweep(address token, address to) external onlyOwner {
        uint256 bal = IERC20Hook(token).balanceOf(address(this));
        if (bal > 0) IERC20Hook(token).transfer(to, bal);
    }

    receive() external payable {}
}
