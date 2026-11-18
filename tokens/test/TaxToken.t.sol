// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {TaxToken} from "../src/TaxToken.sol";
import {MockRouter} from "./mocks/MockRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Unit tests for TaxToken: tax math, burn, buyback, LP add,
/// and the anti-honeypot guarantees (no hidden mint, no blacklist,
/// tax capped at 10%, renounce works, processing stays permissionless).
contract TaxTokenTest is Test {
    TaxToken internal token;
    MockRouter internal router;
    MockERC20 internal weth;
    MockERC20 internal quote; // Arc-style USDC stand-in

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal pairAddr = makeAddr("pair"); // mock liquidity-pool pair

    uint256 internal constant SUPPLY = 1_000_000_000 ether;
    uint256 internal constant TAX_BPS = 500; // 5%
    uint256 internal constant BURN_SHARE = 4000; // 40% of tax
    uint256 internal constant BUYBACK_SHARE = 3000; // 30% of tax
    uint256 internal constant LP_SHARE = 3000; // 30% of tax

    function setUp() public {
        weth = new MockERC20("Wrapped Ether", "WETH");
        quote = new MockERC20("USD Coin", "USDC");
        router = new MockRouter(address(weth), address(0x1234));

        vm.prank(owner);
        token = new TaxToken(
            "Burner Test Token",
            "BURN",
            SUPPLY,
            TAX_BPS,
            BURN_SHARE,
            BUYBACK_SHARE,
            LP_SHARE,
            address(router),
            address(0), // ETH path
            owner
        );

        // Fund the mock router so it can pay out the buy leg.
        vm.deal(address(router), 1_000_000 ether);
        vm.prank(owner);
        token.transfer(address(router), 500_000 ether);
        // Fund the mock pair so it can send buys, then point the tax at it.
        // (Owner -> pair is untaxed: the owner is excluded, and the pair
        // is not set yet at this point anyway.)
        vm.prank(owner);
        token.transfer(pairAddr, 1_000_000 ether);
        vm.prank(owner);
        token.setPair(pairAddr);
        // Fund users (owner is tax-excluded, so funding is untaxed).
        vm.prank(owner);
        token.transfer(alice, 1_000_000 ether);
        vm.prank(owner);
        token.transfer(bob, 1_000_000 ether);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev One taxed transfer; returns (tax, burn, buyback, lp) for the amount.
    function _taxSplit(uint256 amount) internal pure returns (uint256, uint256, uint256, uint256) {
        uint256 tax = (amount * TAX_BPS) / 10000;
        uint256 burn = (tax * BURN_SHARE) / 10000;
        uint256 buyback = (tax * BUYBACK_SHARE) / 10000;
        uint256 lp = tax - burn - buyback;
        return (tax, burn, buyback, lp);
    }

    // ------------------------------------------------------------------
    // Tax math — buys/sells only (pair-based)
    // ------------------------------------------------------------------

    function testWalletToWalletIsTaxFree() public {
        uint256 amount = 10_000 ether;
        uint256 supplyBefore = token.totalSupply();

        vm.prank(alice);
        token.transfer(bob, amount);

        assertEq(token.balanceOf(bob), 1_000_000 ether + amount, "wallet-to-wallet transfer is tax-free");
        assertEq(token.totalSupply(), supplyBefore, "no burn on wallet transfer");
        assertEq(token.buybackReserve(), 0, "no buyback reserve from wallet transfer");
        assertEq(token.liquidityReserve(), 0, "no lp reserve from wallet transfer");
    }

    function testSellIsTaxed() public {
        uint256 amount = 10_000 ether;
        (uint256 tax, uint256 burn, uint256 buyback, uint256 lp) = _taxSplit(amount);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(alice);
        token.transfer(pairAddr, amount);

        assertEq(token.balanceOf(pairAddr), 1_000_000 ether + amount - tax, "pair receives amount minus tax");
        assertEq(token.totalSupply(), supplyBefore - burn, "burn share leaves supply");
        assertEq(token.buybackReserve(), buyback, "buyback reserve");
        assertEq(token.liquidityReserve(), lp, "liquidity reserve");
        assertEq(token.balanceOf(address(token)), buyback + lp, "contract holds the reserves");
        assertEq(burn, 200 ether, "burn is 40% of the 5% tax");
        assertEq(buyback, 150 ether, "buyback is 30% of the tax");
        assertEq(lp, 150 ether, "lp is 30% of the tax");
    }

    function testBuyIsTaxed() public {
        uint256 amount = 10_000 ether;
        (uint256 tax, uint256 burn, uint256 buyback, uint256 lp) = _taxSplit(amount);
        uint256 supplyBefore = token.totalSupply();

        vm.prank(pairAddr);
        token.transfer(bob, amount);

        assertEq(token.balanceOf(bob), 1_000_000 ether + amount - tax, "buyer receives amount minus tax");
        assertEq(token.totalSupply(), supplyBefore - burn, "burn share leaves supply");
        assertEq(token.buybackReserve(), buyback, "buyback reserve");
        assertEq(token.liquidityReserve(), lp, "liquidity reserve");
    }

    function testSellTaxFuzz(uint256 amount) public {
        amount = bound(amount, 1_000, 100_000 ether);
        (uint256 tax, uint256 burn, uint256 buyback, uint256 lp) = _taxSplit(amount);
        uint256 supplyBefore = token.totalSupply();
        uint256 pairBefore = token.balanceOf(pairAddr);
        uint256 contractBefore = token.balanceOf(address(token));

        vm.prank(alice);
        token.transfer(pairAddr, amount);

        // Conservation: nothing is created or lost except the burn.
        assertEq(token.balanceOf(pairAddr) - pairBefore, amount - tax, "pair delta");
        assertEq(supplyBefore - token.totalSupply(), burn, "burned delta");
        assertEq(token.balanceOf(address(token)) - contractBefore, buyback + lp, "reserve delta");
        assertEq(burn + buyback + lp, tax, "splits sum to the tax exactly - no dust lost");
    }

    function testTinyTransferPaysNoTax() public {
        // 1 wei wallet transfer: tax-free by the pair rule.
        vm.prank(alice);
        token.transfer(bob, 1);
        assertEq(token.balanceOf(bob), 1_000_000 ether + 1, "1 wei transfer untaxed");
    }

    function testExcludedAddressesPayNoTax() public {
        // Owner is excluded: full amount arrives, no burn, no reserves.
        uint256 supplyBefore = token.totalSupply();
        vm.prank(owner);
        token.transfer(alice, 10_000 ether);
        assertEq(token.balanceOf(alice), 1_000_000 ether + 10_000 ether, "owner transfer untaxed");
        assertEq(token.totalSupply(), supplyBefore, "no burn on excluded transfer");
        assertEq(token.buybackReserve(), 0, "no buyback reserve from excluded transfer");
        assertEq(token.liquidityReserve(), 0, "no lp reserve from excluded transfer");
        assertTrue(token.isExcludedFromTax(owner), "owner excluded");
        assertTrue(token.isExcludedFromTax(address(token)), "contract excluded");
        assertTrue(token.isExcludedFromTax(address(router)), "router excluded");
    }

    function testZeroTaxDisablesTax() public {
        vm.prank(owner);
        token.setTax(0, BURN_SHARE, BUYBACK_SHARE, LP_SHARE);
        uint256 supplyBefore = token.totalSupply();
        vm.prank(alice);
        token.transfer(pairAddr, 10_000 ether);
        assertEq(token.balanceOf(pairAddr), 1_000_000 ether + 10_000 ether, "zero tax, full amount on sell");
        assertEq(token.totalSupply(), supplyBefore, "zero tax, no burn");
    }

    // ------------------------------------------------------------------
    // Burn / buyback / LP
    // ------------------------------------------------------------------

    // Reserves only build on buys/sells now: a sell (alice -> pair).
    function _buildReserves(uint256 transferAmount) internal {
        vm.prank(alice);
        token.transfer(pairAddr, transferAmount);
    }

    function testBuybackEthPath() public {
        _buildReserves(100_000 ether); // buyback reserve = 1,500
        assertEq(token.buybackReserve(), 1_500 ether, "reserve built");
        uint256 supplyBefore = token.totalSupply();

        vm.prank(carol); // anyone may call
        token.processBuyback();

        assertEq(token.buybackReserve(), 0, "reserve drained");
        assertEq(token.totalSupply(), supplyBefore - 1_500 ether, "bought tokens burned (1:1 mock)");
        // The mock records the LAST swap, which is the buy leg: WETH -> token.
        assertEq(router.lastSwapTokenIn(), address(weth), "buy leg spent WETH");
        assertEq(router.lastSwapTokenOut(), address(token), "buy leg bought the token");
        assertEq(router.lastSwapIn(), 1_500 ether, "buy leg spent the sold proceeds");
    }

    function testAddLiquidityEthPath() public {
        _buildReserves(100_000 ether); // lp reserve = 1,500
        assertEq(token.liquidityReserve(), 1_500 ether, "reserve built");

        vm.prank(carol); // anyone may call
        token.addLiquidity();

        assertEq(token.liquidityReserve(), 0, "reserve drained");
        assertEq(router.lastLpAmountA(), 750 ether, "other half added as tokens");
        assertEq(router.lastLpEth(), 750 ether, "half swapped to ETH and added");
        assertTrue(router.lastLpWasEth(), "ETH-path LP");
        assertEq(router.lastLpTo(), owner, "LP tokens go to the owner");
    }

    function testBuybackAndLpOnTokenQuotePath() public {
        // Arc-style deployment: quote token is an ERC-20 (USDC), not ETH.
        MockRouter router2 = new MockRouter(address(weth), address(0x1234));
        vm.deal(address(router2), 1_000_000 ether);
        quote.mint(address(router2), 1_000_000 ether);

        vm.prank(owner);
        TaxToken arcToken = new TaxToken(
            "Burner Arc Token", "BURN", SUPPLY, TAX_BPS, BURN_SHARE, BUYBACK_SHARE, LP_SHARE,
            address(router2), address(quote), owner
        );
        vm.prank(owner);
        arcToken.transfer(address(router2), 500_000 ether);
        vm.prank(owner);
        arcToken.transfer(alice, 1_000_000 ether);
        // The arc token needs its own pair pointer + pair funding.
        vm.prank(owner);
        arcToken.transfer(pairAddr, 1_000_000 ether);
        vm.prank(owner);
        arcToken.setPair(pairAddr);
        // A sell on Arc routes through the token's own reserves.
        vm.prank(alice);
        arcToken.transfer(pairAddr, 100_000 ether);
        assertEq(arcToken.buybackReserve(), 1_500 ether, "buyback reserve on quote path");
        assertEq(arcToken.liquidityReserve(), 1_500 ether, "lp reserve on quote path");

        uint256 supplyBefore = arcToken.totalSupply();
        vm.prank(carol);
        arcToken.processBuyback();
        assertEq(arcToken.buybackReserve(), 0, "buyback reserve drained");
        assertEq(arcToken.totalSupply(), supplyBefore - 1_500 ether, "bought tokens burned");

        vm.prank(carol);
        arcToken.addLiquidity();
        assertEq(arcToken.liquidityReserve(), 0, "lp reserve drained");
        assertEq(router2.lastLpTokenB(), address(quote), "LP paired with the quote token");
        assertEq(router2.lastLpAmountA(), 750 ether, "other half added as tokens");
        assertEq(router2.lastLpAmountB(), 750 ether, "half swapped to quote and added");
        assertFalse(router2.lastLpWasEth(), "token-path LP, not ETH");
    }

    function testBuybackAndLpRequireRouter() public {
        vm.prank(owner);
        TaxToken noRouter = new TaxToken(
            "No Router", "NR", SUPPLY, TAX_BPS, BURN_SHARE, BUYBACK_SHARE, LP_SHARE,
            address(0), address(0), owner
        );
        vm.prank(owner);
        noRouter.transfer(alice, 1_000_000 ether);
        // No router: reserves still build up on sells, but the tax
        // process is skipped (not reverted) so trades keep working.
        vm.prank(owner);
        noRouter.transfer(pairAddr, 1_000_000 ether);
        vm.prank(owner);
        noRouter.setPair(pairAddr);
        vm.prank(alice);
        noRouter.transfer(pairAddr, 100_000 ether);
        assertEq(noRouter.buybackReserve(), 1_500 ether, "reserves still build with no router");

        vm.expectRevert(TaxToken.RouterNotSet.selector);
        noRouter.processBuyback();
        vm.expectRevert(TaxToken.RouterNotSet.selector);
        noRouter.addLiquidity();
    }

    function testThresholdsGateProcessing() public {
        _buildReserves(100_000 ether); // reserves = 1,500 each
        vm.prank(owner);
        token.setThresholds(2_000 ether, 2_000 ether);
        vm.expectRevert(abi.encodeWithSelector(TaxToken.ReserveTooSmall.selector, 1_500 ether, 2_000 ether));
        token.processBuyback();
        vm.expectRevert(abi.encodeWithSelector(TaxToken.ReserveTooSmall.selector, 1_500 ether, 2_000 ether));
        token.addLiquidity();

        vm.prank(owner);
        token.setThresholds(0, 0);
        token.processBuyback();
        assertEq(token.buybackReserve(), 0, "works once threshold is lowered");
    }

    function testSetRouter() public {
        MockRouter router2 = new MockRouter(address(weth), address(0x5678));
        vm.prank(owner);
        token.setRouter(address(router2));
        assertEq(address(token.router()), address(router2), "router updated");
        assertTrue(token.isExcludedFromTax(address(router2)), "new router excluded");
        assertFalse(token.isExcludedFromTax(address(router)), "old router un-excluded");

        vm.prank(owner);
        token.setRouter(address(0));
        assertEq(address(token.router()), address(0), "router can be disabled");
    }

    // ------------------------------------------------------------------
    // Anti-honeypot guarantees
    // ------------------------------------------------------------------

    function testTaxCappedAtTenPercent() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(TaxToken.TaxTooHigh.selector, 1001, 1000));
        token.setTax(1001, BURN_SHARE, BUYBACK_SHARE, LP_SHARE);

        vm.prank(owner);
        token.setTax(1000, BURN_SHARE, BUYBACK_SHARE, LP_SHARE); // boundary: 10% is allowed
        assertEq(token.taxBps(), 1000, "10% tax is the max allowed");

        vm.prank(owner);
        token.setTax(TAX_BPS, BURN_SHARE, BUYBACK_SHARE, LP_SHARE); // restore
    }

    function testSharesMustSumTo10000() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(TaxToken.InvalidShares.selector, 4000, 3000, 2999)
        );
        token.setTax(500, 4000, 3000, 2999);
    }

    function testOnlyOwnerCanChangeTax() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice)
        );
        token.setTax(100, BURN_SHARE, BUYBACK_SHARE, LP_SHARE);
    }

    function testNoHiddenMint() public {
        // There is no mint function at all: a call to mint() reverts.
        (bool ok,) = address(token).call(
            abi.encodeWithSignature("mint(address,uint256)", alice, 1 ether)
        );
        assertFalse(ok, "mint() does not exist");

        // Supply only ever goes down (burns), never up.
        uint256 supplyBefore = token.totalSupply();
        vm.prank(alice);
        token.transfer(bob, 10_000 ether);
        assertLe(token.totalSupply(), supplyBefore, "supply never increases");

        // Accounting identity: every token is held by someone
        // (owner, alice, bob, router, pair, contract).
        assertEq(
            token.balanceOf(owner) + token.balanceOf(alice) + token.balanceOf(bob)
                + token.balanceOf(address(router)) + token.balanceOf(pairAddr)
                + token.balanceOf(address(token)),
            token.totalSupply(),
            "balances sum to totalSupply"
        );
    }

    function testNoBlacklist() public {
        // There is no blacklist function at all.
        (bool ok,) = address(token).call(
            abi.encodeWithSignature("blacklist(address)", alice)
        );
        assertFalse(ok, "blacklist() does not exist");
        (ok,) = address(token).call(
            abi.encodeWithSignature("setBlacklist(address,bool)", alice, true)
        );
        assertFalse(ok, "setBlacklist() does not exist");

        // Any address, even a fresh one, can send and receive.
        address stranger = makeAddr("stranger");
        vm.prank(owner);
        token.transfer(stranger, 1_000 ether);
        vm.prank(stranger);
        token.transfer(carol, 500 ether);
        assertEq(token.balanceOf(carol), 500 ether, "stranger transfer works, tax-free wallet-to-wallet");
    }

    // ------------------------------------------------------------------
    // Pair pointer (buys/sells-only tax)
    // ------------------------------------------------------------------

    function testSetPairOnlyOwner() public {
        address newPair = makeAddr("pair2");
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice)
        );
        token.setPair(newPair);

        vm.prank(owner);
        token.setPair(newPair);
        assertEq(token.pair(), newPair, "owner can set the pair");
    }

    function testPairCannotBeExcluded() public {
        vm.prank(owner);
        vm.expectRevert(TaxToken.CannotChangePairExclusion.selector);
        token.setExcluded(pairAddr, true);
    }

    function testSetPairClearsExclusion() public {
        // An address excluded first, then made the pair, is un-excluded
        // automatically so the tax trigger cannot be silently disabled.
        address futurePair = makeAddr("futurePair");
        vm.prank(owner);
        token.setExcluded(futurePair, true);
        assertTrue(token.isExcludedFromTax(futurePair), "excluded before");
        vm.prank(owner);
        token.setPair(futurePair);
        assertFalse(token.isExcludedFromTax(futurePair), "setPair clears the exclusion");
    }

    function testTaxInactiveBeforePairSet() public {
        // A fresh token with no pair set: even a transfer to the pair
        // address is tax-free, because pair == address(0).
        vm.prank(owner);
        TaxToken fresh = new TaxToken(
            "Fresh", "FR", SUPPLY, TAX_BPS, BURN_SHARE, BUYBACK_SHARE, LP_SHARE,
            address(router), address(0), owner
        );
        assertEq(fresh.pair(), address(0), "pair starts unset");
        vm.prank(owner);
        fresh.transfer(alice, 1_000_000 ether);
        vm.prank(alice);
        fresh.transfer(pairAddr, 10_000 ether);
        assertEq(fresh.balanceOf(pairAddr), 10_000 ether, "no tax before setPair");
        assertEq(fresh.totalSupply(), SUPPLY, "no burn before setPair");
    }

    function testRenounceOwnership() public {
        vm.prank(owner);
        token.renounceOwnership();
        assertEq(token.owner(), address(0), "ownership renounced");

        // Tax can never change again…
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", address(this))
        );
        token.setTax(100, BURN_SHARE, BUYBACK_SHARE, LP_SHARE);

        // …but transfers keep working and buyback/LP stay permissionless.
        _buildReserves(100_000 ether);
        token.processBuyback();
        assertEq(token.buybackReserve(), 0, "buyback still callable after renounce");
        token.addLiquidity();
        assertEq(token.liquidityReserve(), 0, "LP still callable after renounce");
        vm.prank(alice);
        token.transfer(bob, 1_000 ether);
    }

    function testConstructorRejectsBadParams() public {
        vm.expectRevert(abi.encodeWithSelector(TaxToken.TaxTooHigh.selector, 1001, 1000));
        new TaxToken("X", "X", SUPPLY, 1001, BURN_SHARE, BUYBACK_SHARE, LP_SHARE, address(0), address(0), owner);
        vm.expectRevert(
            abi.encodeWithSelector(TaxToken.InvalidShares.selector, 4000, 3000, 2999)
        );
        new TaxToken("X", "X", SUPPLY, 500, 4000, 3000, 2999, address(0), address(0), owner);
    }

    function testCannotUnexcludeContractItself() public {
        vm.prank(owner);
        vm.expectRevert(TaxToken.CannotChangeSelfExclusion.selector);
        token.setExcluded(address(token), false);
    }

    // ------------------------------------------------------------------
    // CREATE2 deployment — the token contract as deployer
    // ------------------------------------------------------------------

    /// @dev Init code for a MockERC20 with the given name/symbol.
    function _mockInitCode(string memory name_, string memory symbol_) internal pure returns (bytes memory) {
        return abi.encodePacked(type(MockERC20).creationCode, abi.encode(name_, symbol_));
    }

    function testDeployViaCreate2() public {
        bytes memory initCode = _mockInitCode("Deployed Token", "DEP");
        bytes32 salt = bytes32(uint256(0x1234));
        address predicted = token.predictDeploy(keccak256(initCode), salt);

        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(token));
        emit TaxToken.ContractDeployed(predicted, salt);
        address deployed = token.deploy(initCode, salt);

        assertEq(deployed, predicted, "deployed address matches prediction");
        assertGt(deployed.code.length, 0, "deployed contract has code");
        assertEq(MockERC20(deployed).name(), "Deployed Token", "deployed contract works");
        assertEq(MockERC20(deployed).symbol(), "DEP", "deployed contract symbol");
    }

    function testDeployOnlyOwner() public {
        bytes memory initCode = _mockInitCode("Deployed Token", "DEP");
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice)
        );
        token.deploy(initCode, bytes32(uint256(0x1234)));
    }

    function testDeploySameSaltTwiceFails() public {
        bytes memory initCode = _mockInitCode("Deployed Token", "DEP");
        bytes32 salt = bytes32(uint256(0x1234));
        vm.prank(owner);
        token.deploy(initCode, salt);
        vm.prank(owner);
        vm.expectRevert(TaxToken.Create2DeployFailed.selector);
        token.deploy(initCode, salt);
    }

    function testPredictDeployMatchesCreate2Formula() public {
        // Independent recomputation of the CREATE2 address, not via the
        // contract's own predictDeploy() — guards against a wrong formula.
        bytes memory initCode = _mockInitCode("Deployed Token", "DEP");
        bytes32 salt = bytes32(uint256(0x9999));
        bytes32 initCodeHash = keccak256(initCode);
        address expected = address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(token), salt, initCodeHash)))
            )
        );
        assertEq(token.predictDeploy(initCodeHash, salt), expected, "predictDeploy matches the CREATE2 formula");
    }
}
