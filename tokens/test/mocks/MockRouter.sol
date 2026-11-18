// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only Uniswap V2-style router. Swaps 1:1 by value so the
/// token's buyback / LP flows can be tested without a real DEX.
/// @dev Fund with ETH (vm.deal) and with the tokens it must hand out
/// (transfer TaxToken / quote tokens to it) before running swaps.
contract MockRouter {
    address public immutable weth;
    address public immutable factory;

    // Last addLiquidity call, for assertions.
    address public lastLpTokenA;
    address public lastLpTokenB;
    uint256 public lastLpAmountA;
    uint256 public lastLpAmountB;
    uint256 public lastLpEth;
    address public lastLpTo;
    bool public lastLpWasEth;

    // Last swap call, for assertions.
    uint256 public lastSwapIn;
    uint256 public lastSwapOut;
    address public lastSwapTokenIn;
    address public lastSwapTokenOut;

    constructor(address weth_, address factoryAddr_) {
        weth = weth_;
        factory = factoryAddr_;
    }

    function WETH() external view returns (address) {
        return weth;
    }

    function factory_() external view returns (address) {
        return factory;
    }

    receive() external payable {}

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external {
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        lastSwapIn = amountIn;
        lastSwapOut = amountIn; // 1:1 mock
        lastSwapTokenIn = path[0];
        lastSwapTokenOut = path[1];
        (bool ok,) = to.call{value: amountIn}("");
        require(ok, "eth send failed");
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external payable {
        lastSwapIn = msg.value;
        lastSwapOut = msg.value; // 1:1 mock
        lastSwapTokenIn = path[0];
        lastSwapTokenOut = path[1];
        require(IERC20(path[1]).transfer(to, msg.value), "token send failed");
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 /* amountOutMin */,
        address[] calldata path,
        address to,
        uint256 /* deadline */
    ) external {
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "pull failed");
        lastSwapIn = amountIn;
        lastSwapOut = amountIn; // 1:1 mock
        lastSwapTokenIn = path[0];
        lastSwapTokenOut = path[1];
        require(IERC20(path[1]).transfer(to, amountIn), "token send failed");
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 /* amountAMin */,
        uint256 /* amountBMin */,
        address to,
        uint256 /* deadline */
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        require(IERC20(tokenA).transferFrom(msg.sender, address(this), amountADesired), "pull A failed");
        require(IERC20(tokenB).transferFrom(msg.sender, address(this), amountBDesired), "pull B failed");
        lastLpTokenA = tokenA;
        lastLpTokenB = tokenB;
        lastLpAmountA = amountADesired;
        lastLpAmountB = amountBDesired;
        lastLpEth = 0;
        lastLpTo = to;
        lastLpWasEth = false;
        return (amountADesired, amountBDesired, amountADesired + amountBDesired);
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 /* amountTokenMin */,
        uint256 /* amountETHMin */,
        address to,
        uint256 /* deadline */
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        require(IERC20(token).transferFrom(msg.sender, address(this), amountTokenDesired), "pull failed");
        lastLpTokenA = token;
        lastLpTokenB = weth;
        lastLpAmountA = amountTokenDesired;
        lastLpAmountB = msg.value;
        lastLpEth = msg.value;
        lastLpTo = to;
        lastLpWasEth = true;
        return (amountTokenDesired, msg.value, amountTokenDesired + msg.value);
    }
}
