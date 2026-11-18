// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2Router02.sol";

/// @title TaxToken — ERC-20 with a capped, transparent transfer tax
/// @notice Every non-excluded transfer pays a tax (max 10%) that is split
/// three ways: a share is burned immediately, a share is reserved for
/// buyback-and-burn, and a share is reserved for adding liquidity.
/// @dev
/// - Fixed supply: minted once in the constructor. There is NO mint
///   function, NO blacklist, NO pause, NO max-transaction, NO trading
///   toggle. Anyone can read every rule on-chain.
/// - Tax is capped at 10% (MAX_TAX_BPS) forever — the cap is a constant,
///   not a variable, so no owner can ever raise it above 10%.
/// - The owner can change the tax rate / splits / router / exclusions,
///   or renounce ownership entirely. After renounceOwnership() the tax
///   can never change again, while processBuyback() / addLiquidity()
///   stay callable by anyone.
/// - Buyback and liquidity need a Uniswap V2-style router. The token can
///   be deployed with router == address(0); those two functions then
///   revert with RouterNotSet until the owner sets a verified router
///   with setRouter(). Tax and burn work with no router at all.
/// - Two quote modes: quoteToken == address(0) means the chain's native
///   asset (ETH path: WETH via the router). quoteToken != address(0)
///   means an ERC-20 quote token (e.g. Arc, where USDC is the native
///   gas token and the router's WETH paths revert — use the USDC
///   predeploy 0x3600...0000 as quoteToken).
/// - Swaps use amountOutMin = 0. That is fine on testnets, but on
///   mainnet a public buyback/LP call can be sandwiched. Mainnet
///   deployments should add slippage protection or a trusted keeper.
/// - deploy() lets the owner deploy other contracts via CREATE2 with
///   this contract as the deployer (the $AGNA vanity system: the token
///   contract deploys the NameSBT registry so both addresses carry the
///   0xa69000 prefix). See tokens/README.md "Vanity addresses".
/// - TAX MODEL (changed 2026-11-18): the transfer tax applies ONLY to
///   buys and sells — a transfer TO the liquidity-pool pair (a sell)
///   or FROM the pair (a buy). Plain wallet-to-wallet transfers are
///   tax-free. The pair address is set by the owner with setPair()
///   AFTER the pool is created (until then pair == address(0) and no
///   transfer is taxed). The owner, the router, and this contract are
///   tax-exempt, so the initial liquidity add and the agent allocation
///   are never taxed. The pair itself can never be excluded (see
///   setExcluded), or the tax trigger would silently stop working.
contract TaxToken is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    /// @notice Hard cap on the total transfer tax: 10% (1000 bps).
    /// A constant — no owner, now or later, can raise the tax above this.
    uint256 public constant MAX_TAX_BPS = 1000;
    uint256 public constant BPS_DENOMINATOR = 10000;

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /// @notice Total transfer tax in basis points (0–1000).
    uint256 public taxBps;
    /// @notice Share of the tax that is burned, in bps of the tax (0–10000).
    uint256 public burnShareBps;
    /// @notice Share of the tax reserved for buyback, in bps of the tax.
    uint256 public buybackShareBps;
    /// @notice Share of the tax reserved for liquidity, in bps of the tax.
    /// @dev burnShareBps + buybackShareBps + liquidityShareBps == 10000 always.
    uint256 public liquidityShareBps;

    /// @notice Uniswap V2-style router for buyback / liquidity. May be address(0).
    IUniswapV2Router02 public router;
    /// @notice Quote token for swaps. address(0) = native ETH path, else ERC-20 path.
    address public quoteToken;

    /// @notice Tax tokens reserved for buyback-and-burn.
    uint256 public buybackReserve;
    /// @notice Tax tokens reserved for adding liquidity.
    uint256 public liquidityReserve;

    /// @notice Minimum buybackReserve before processBuyback() may run (0 = any amount).
    uint256 public buybackThreshold;
    /// @notice Minimum liquidityReserve before addLiquidity() may run (0 = any amount).
    uint256 public liquidityThreshold;

    /// @notice Addresses that neither pay nor receive tax (owner, contract, router…).
    mapping(address => bool) public isExcludedFromTax;

    /// @notice The liquidity-pool pair (Uniswap V2 pair) for this token.
    /// @dev The tax applies ONLY to transfers to/from this address (a
    /// sell / a buy). Set by the owner with setPair() after the pool
    /// is created; address(0) until then, which means no transfer is
    /// taxed yet. The pair can never be tax-excluded (see setExcluded).
    address public pair;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error TaxTooHigh(uint256 requestedBps, uint256 maxBps);
    error InvalidShares(uint256 burnBps, uint256 buybackBps, uint256 liquidityBps);
    error RouterNotSet();
    error ReserveTooSmall(uint256 reserve, uint256 threshold);
    error ZeroAddress();
    error CannotChangeSelfExclusion();
    error CannotChangePairExclusion();
    error Create2DeployFailed();

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event TaxUpdated(uint256 taxBps, uint256 burnShareBps, uint256 buybackShareBps, uint256 liquidityShareBps);
    event RouterUpdated(address indexed router);
    event QuoteTokenUpdated(address indexed quoteToken);
    event ThresholdsUpdated(uint256 buybackThreshold, uint256 liquidityThreshold);
    event ExcludedUpdated(address indexed account, bool excluded);
    event PairUpdated(address indexed pair);
    event BuybackProcessed(uint256 indexed sold, uint256 indexed bought, uint256 quoteReceived);
    event LiquidityAdded(uint256 indexed tokenAmount, uint256 indexed quoteAmount, uint256 liquidity, address indexed lpRecipient);
    event ContractDeployed(address indexed deployed, bytes32 indexed salt);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply_,
        uint256 taxBps_,
        uint256 burnShareBps_,
        uint256 buybackShareBps_,
        uint256 liquidityShareBps_,
        address router_,
        address quoteToken_,
        address owner_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        _setTax(taxBps_, burnShareBps_, buybackShareBps_, liquidityShareBps_);
        router = IUniswapV2Router02(router_);
        quoteToken = quoteToken_;

        // The contract itself, the owner and the router never pay tax.
        // Excluding the contract is load-bearing: internal reserve
        // movements (tax collection, swaps, LP) must not be taxed.
        isExcludedFromTax[address(this)] = true;
        isExcludedFromTax[owner_] = true;
        if (router_ != address(0)) isExcludedFromTax[router_] = true;

        _mint(owner_, initialSupply_);
    }

    // ------------------------------------------------------------------
    // Tax logic
    // ------------------------------------------------------------------

    /// @notice Applies the tax on buys and sells ONLY: a transfer TO
    /// the liquidity-pool pair (a sell) or FROM the pair (a buy).
    /// Plain wallet-to-wallet transfers are tax-free.
    /// @dev Mint (from == 0) and burn (to == 0) are never taxed.
    /// Remainder dust from the share split goes to the liquidity share,
    /// so burn + buyback + liquidity == tax exactly. No dust is ever lost.
    function _update(address from, address to, uint256 value) internal override {
        bool isBuyOrSell = (from == pair || to == pair);
        if (from != address(0) && to != address(0) && taxBps > 0 && isBuyOrSell && !isExcludedFromTax[from]
            && !isExcludedFromTax[to]) {
            uint256 tax = (value * taxBps) / BPS_DENOMINATOR;
            if (tax > 0) {
                uint256 burnAmt = (tax * burnShareBps) / BPS_DENOMINATOR;
                uint256 buybackAmt = (tax * buybackShareBps) / BPS_DENOMINATOR;
                uint256 lpAmt = tax - burnAmt - buybackAmt; // remainder -> LP, no dust lost
                uint256 reserveAmt = buybackAmt + lpAmt;

                super._update(from, to, value - tax);
                if (burnAmt > 0) _burn(from, burnAmt);
                if (reserveAmt > 0) {
                    super._update(from, address(this), reserveAmt);
                    buybackReserve += buybackAmt;
                    liquidityReserve += lpAmt;
                }
                return;
            }
        }
        super._update(from, to, value);
    }

    // ------------------------------------------------------------------
    // Owner settings
    // ------------------------------------------------------------------

    /// @notice Change the tax rate and its three-way split.
    /// @dev Total tax can never exceed MAX_TAX_BPS (10%); the three
    /// shares must add to exactly 10000 (100% of the tax).
    function setTax(uint256 taxBps_, uint256 burnShareBps_, uint256 buybackShareBps_, uint256 liquidityShareBps_)
        external
        onlyOwner
    {
        _setTax(taxBps_, burnShareBps_, buybackShareBps_, liquidityShareBps_);
    }

    function _setTax(uint256 taxBps_, uint256 burnShareBps_, uint256 buybackShareBps_, uint256 liquidityShareBps_)
        internal
    {
        if (taxBps_ > MAX_TAX_BPS) revert TaxTooHigh(taxBps_, MAX_TAX_BPS);
        if (burnShareBps_ + buybackShareBps_ + liquidityShareBps_ != BPS_DENOMINATOR) {
            revert InvalidShares(burnShareBps_, buybackShareBps_, liquidityShareBps_);
        }
        taxBps = taxBps_;
        burnShareBps = burnShareBps_;
        buybackShareBps = buybackShareBps_;
        liquidityShareBps = liquidityShareBps_;
        emit TaxUpdated(taxBps_, burnShareBps_, buybackShareBps_, liquidityShareBps_);
    }

    /// @notice Point the token at a verified Uniswap V2-style router (or back to address(0) to disable).
    /// @dev Manages the router's tax exclusion automatically.
    function setRouter(address router_) external onlyOwner {
        address oldRouter = address(router);
        if (oldRouter != address(0)) isExcludedFromTax[oldRouter] = false;
        router = IUniswapV2Router02(router_);
        if (router_ != address(0)) isExcludedFromTax[router_] = true;
        emit RouterUpdated(router_);
    }

    /// @notice Set the quote token: address(0) = native ETH path, else an ERC-20 (e.g. Arc USDC).
    function setQuoteToken(address quoteToken_) external onlyOwner {
        quoteToken = quoteToken_;
        emit QuoteTokenUpdated(quoteToken_);
    }

    /// @notice Minimum reserves before the permissionless process functions may run.
    function setThresholds(uint256 buybackThreshold_, uint256 liquidityThreshold_) external onlyOwner {
        buybackThreshold = buybackThreshold_;
        liquidityThreshold = liquidityThreshold_;
        emit ThresholdsUpdated(buybackThreshold_, liquidityThreshold_);
    }

    /// @notice Set the liquidity-pool pair address that the tax applies
    /// to (buys/sells). Owner-only; call it after the pool is created
    /// (the pool script does this automatically).
    /// @dev The pair can never be tax-excluded, so any exclusion on
    /// this address is cleared here — otherwise the tax trigger would
    /// silently stop working. Setting pair back to address(0) turns
    /// the tax off for every transfer (same effect as setTax(0)).
    function setPair(address pair_) external onlyOwner {
        pair = pair_;
        if (pair_ != address(0)) isExcludedFromTax[pair_] = false;
        emit PairUpdated(pair_);
    }

    /// @notice Exclude (or un-exclude) an address from the tax.
    /// @dev The contract itself can never be un-excluded: internal
    /// reserve movements must stay untaxed or the accounting breaks.
    /// The pair can never be excluded either: it is the tax trigger.
    function setExcluded(address account, bool excluded) external onlyOwner {
        if (account == address(this)) revert CannotChangeSelfExclusion();
        if (account == pair) revert CannotChangePairExclusion();
        isExcludedFromTax[account] = excluded;
        emit ExcludedUpdated(account, excluded);
    }

    // ------------------------------------------------------------------
    // Buyback-and-burn (permissionless — anyone may call)
    // ------------------------------------------------------------------

    /// @notice Sell the whole buyback reserve for the quote asset, use it
    /// to buy this token back on the market, and burn what was bought.
    /// @dev Anyone may call this. The reserve is zeroed before any
    /// external call (reentrancy-safe) and the function is nonReentrant.
    function processBuyback() external nonReentrant {
        if (address(router) == address(0)) revert RouterNotSet();
        uint256 amount = buybackReserve;
        if (amount == 0 || amount < buybackThreshold) revert ReserveTooSmall(amount, buybackThreshold);
        buybackReserve = 0;

        uint256 quoteReceived;
        uint256 bought;

        if (quoteToken == address(0)) {
            // ETH path: tokens -> ETH -> tokens -> burn.
            address weth = router.WETH();
            IERC20(address(this)).forceApprove(address(router), amount);
            address[] memory sellPath = new address[](2);
            sellPath[0] = address(this);
            sellPath[1] = weth;
            uint256 ethBefore = address(this).balance;
            router.swapExactTokensForETHSupportingFeeOnTransferTokens(
                amount, 0, sellPath, address(this), block.timestamp + 600
            );
            quoteReceived = address(this).balance - ethBefore;

            // Measure the buy leg against the post-sell balance: the
            // contract also holds the untouched liquidity reserve, so a
            // pre-sell baseline would read the buyback as zero.
            uint256 tokenBeforeBuy = balanceOf(address(this));
            address[] memory buyPath = new address[](2);
            buyPath[0] = weth;
            buyPath[1] = address(this);
            router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: quoteReceived}(
                0, buyPath, address(this), block.timestamp + 600
            );
            bought = balanceOf(address(this)) - tokenBeforeBuy;
        } else {
            // ERC-20 quote path (e.g. Arc USDC): tokens -> quote -> tokens -> burn.
            uint256 quoteBefore = IERC20(quoteToken).balanceOf(address(this));
            IERC20(address(this)).forceApprove(address(router), amount);
            address[] memory sellPath = new address[](2);
            sellPath[0] = address(this);
            sellPath[1] = quoteToken;
            router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amount, 0, sellPath, address(this), block.timestamp + 600
            );
            quoteReceived = IERC20(quoteToken).balanceOf(address(this)) - quoteBefore;

            uint256 tokenBeforeBuy = balanceOf(address(this));
            IERC20(quoteToken).forceApprove(address(router), quoteReceived);
            address[] memory buyPath = new address[](2);
            buyPath[0] = quoteToken;
            buyPath[1] = address(this);
            router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                quoteReceived, 0, buyPath, address(this), block.timestamp + 600
            );
            bought = balanceOf(address(this)) - tokenBeforeBuy;
        }

        if (bought > 0) _burn(address(this), bought);
        emit BuybackProcessed(amount, bought, quoteReceived);
    }

    // ------------------------------------------------------------------
    // Auto-liquidity (permissionless — anyone may call)
    // ------------------------------------------------------------------

    /// @notice Add the whole liquidity reserve as liquidity with the quote asset.
    /// @dev Swaps half the reserve for the quote asset, then adds
    /// (other half + quote) as liquidity. LP tokens go to the owner —
    /// on mainnet send them to a locker / burn them instead of holding
    /// them in a wallet. Anyone may call this.
    function addLiquidity() external nonReentrant {
        if (address(router) == address(0)) revert RouterNotSet();
        uint256 amount = liquidityReserve;
        if (amount == 0 || amount < liquidityThreshold) revert ReserveTooSmall(amount, liquidityThreshold);
        liquidityReserve = 0;

        uint256 half = amount / 2;
        uint256 otherHalf = amount - half;
        uint256 tokenUsed;
        uint256 quoteReceived;
        uint256 liquidity;

        if (quoteToken == address(0)) {
            // ETH path.
            address weth = router.WETH();
            IERC20(address(this)).forceApprove(address(router), amount);
            address[] memory path = new address[](2);
            path[0] = address(this);
            path[1] = weth;
            uint256 ethBefore = address(this).balance;
            router.swapExactTokensForETHSupportingFeeOnTransferTokens(
                half, 0, path, address(this), block.timestamp + 600
            );
            quoteReceived = address(this).balance - ethBefore;

            (tokenUsed, quoteReceived, liquidity) = router.addLiquidityETH{value: quoteReceived}(
                address(this), otherHalf, 0, 0, owner(), block.timestamp + 600
            );
        } else {
            // ERC-20 quote path (e.g. Arc USDC).
            uint256 quoteBefore = IERC20(quoteToken).balanceOf(address(this));
            IERC20(address(this)).forceApprove(address(router), amount);
            address[] memory path = new address[](2);
            path[0] = address(this);
            path[1] = quoteToken;
            router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                half, 0, path, address(this), block.timestamp + 600
            );
            quoteReceived = IERC20(quoteToken).balanceOf(address(this)) - quoteBefore;

            IERC20(quoteToken).forceApprove(address(router), quoteReceived);
            (tokenUsed, quoteReceived, liquidity) = router.addLiquidity(
                address(this), quoteToken, otherHalf, quoteReceived, 0, 0, owner(), block.timestamp + 600
            );
        }

        emit LiquidityAdded(tokenUsed, quoteReceived, liquidity, owner());
    }

    // ------------------------------------------------------------------
    // CREATE2 deployment — the token contract as deployer
    // ------------------------------------------------------------------

    /// @notice Deploy a contract via CREATE2 with THIS token contract as
    /// the deployer (msg.sender of the deployed contract's constructor
    /// is this contract). Owner-only.
    /// @dev This is how $AGNA deploys the NameSBT registry (and any
    /// future contract) so the deployed address is vanity-mined against
    /// this contract's address: the salt is mined off-chain so that
    /// keccak256(0xff ++ address(this) ++ salt ++ keccak256(initCode))
    /// starts with the 0xa69000 prefix. The deployed contract's
    /// constructor MUST take an explicit owner (see NameSBT) — otherwise
    /// this contract would own it and nobody could mint names.
    /// Emits ContractDeployed. Reverts if CREATE2 returns address(0)
    /// (e.g. the salt was already used for this init code).
    function deploy(bytes memory initCode, bytes32 salt) external onlyOwner returns (address deployed) {
        assembly {
            deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        if (deployed == address(0)) revert Create2DeployFailed();
        emit ContractDeployed(deployed, salt);
    }

    /// @notice Predict the address `deploy` would create for this init
    /// code hash and salt. Used by the off-chain vanity salt miner to
    /// verify a mined salt before sending the transaction.
    function predictDeploy(bytes32 initCodeHash, bytes32 salt) external view returns (address) {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))
            )
        );
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @notice Current (buybackReserve, liquidityReserve).
    function getReserves() external view returns (uint256, uint256) {
        return (buybackReserve, liquidityReserve);
    }

    /// @notice The router sends ETH here during buyback / LP swaps.
    receive() external payable {}
}
