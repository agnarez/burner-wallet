// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test-only Uniswap V2-style factory: getPair only.
/// Used by the Anvil end-to-end test of create-pool.cjs so the script's
/// pair-existence check can be exercised without a real DEX.
/// The pair address is set manually with setPair().
contract MockV2Factory {
    address public pair;

    function setPair(address pair_) external {
        pair = pair_;
    }

    function getPair(address, address) external view returns (address) {
        return pair;
    }
}
