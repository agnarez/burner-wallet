// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only Uniswap V2-style pair: getReserves / token0 /
/// token1 / balanceOf only. Used by the Anvil end-to-end test of
/// create-pool.cjs. Reserves and LP balances are set manually.
/// @dev The mock router's addLiquidityETH does not mint real LP tokens,
/// so balanceOf stays 0 in the Anvil test — the script's LP accounting
/// is verified on the live router instead. The e2e asserts the router
/// call (amounts + recipient), not the mock LP balance.
contract MockV2Pair {
    address public token0;
    address public token1;
    uint112 public reserve0;
    uint112 public reserve1;
    mapping(address => uint256) public balanceOf;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setReserves(uint112 reserve0_, uint112 reserve1_) external {
        reserve0 = reserve0_;
        reserve1 = reserve1_;
    }

    function setLpBalance(address to, uint256 amount) external {
        balanceOf[to] = amount;
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 0);
    }
}
