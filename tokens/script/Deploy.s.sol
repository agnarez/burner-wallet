// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {TaxToken} from "../src/TaxToken.sol";

/// @notice Deploys TaxToken from config/token-config.json.
/// @dev Usage:
///   cp .env.example .env   # fill in PRIVATE_KEY (burner deployer key) — never commit it
///   source .env
///   forge script script/Deploy.s.sol --rpc-url $ARC_TESTNET_RPC_URL --broadcast
///   # or Sepolia (burner holds 0.05 ETH):
///   CHAIN_ID=11155111 forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast
/// The deployer key MUST be the burner wallet's key (checked against
/// config). The Circle agent wallet never signs — it only receives its
/// allocation. Chains with no gas funded refuse to deploy (see config).
contract Deploy is Script {
    struct DeployConfig {
        uint256 chainId;
        string chainName;
        string name;
        string symbol;
        uint256 initialSupply;
        uint256 taxBps;
        uint256 burnShare;
        uint256 buybackShare;
        uint256 lpShare;
        uint256 agentAllocationBps;
        address burner;
        address agent;
        address router;
        address quoteToken;
        bool deployable;
    }

    function _loadConfig(string memory json, uint256 chainId) internal view returns (DeployConfig memory cfg) {
        cfg.chainId = chainId;
        cfg.name = vm.parseJsonString(json, ".token.name");
        cfg.symbol = vm.parseJsonString(json, ".token.symbol");
        uint256 supplyTokens = vm.parseJsonUint(json, ".token.initialSupplyTokens");
        uint256 decimals = vm.parseJsonUint(json, ".token.decimals");
        cfg.initialSupply = supplyTokens * (10 ** decimals);
        cfg.taxBps = vm.parseJsonUint(json, ".token.taxBps");
        cfg.burnShare = vm.parseJsonUint(json, ".token.burnShareBps");
        cfg.buybackShare = vm.parseJsonUint(json, ".token.buybackShareBps");
        cfg.lpShare = vm.parseJsonUint(json, ".token.liquidityShareBps");
        cfg.agentAllocationBps = vm.parseJsonUint(json, ".token.agentAllocationBps");
        cfg.burner = vm.parseAddress(vm.parseJsonString(json, ".wallets.burner"));
        cfg.agent = vm.parseAddress(vm.parseJsonString(json, ".wallets.agent"));

        string memory base = string.concat(".chains.", vm.toString(chainId));
        cfg.chainName = vm.parseJsonString(json, string.concat(base, ".name"));
        string memory routerStr = vm.parseJsonString(json, string.concat(base, ".router"));
        cfg.router = bytes(routerStr).length == 0 ? address(0) : vm.parseAddress(routerStr);
        string memory quoteStr = vm.parseJsonString(json, string.concat(base, ".quoteToken"));
        cfg.quoteToken = bytes(quoteStr).length == 0 ? address(0) : vm.parseAddress(quoteStr);
        cfg.deployable = vm.parseJsonBool(json, string.concat(base, ".deployable"));
    }

    function run() external {
        string memory json = vm.readFile("config/token-config.json");
        uint256 chainId = vm.envOr("CHAIN_ID", block.chainid);
        DeployConfig memory cfg = _loadConfig(json, chainId);
        require(cfg.deployable, "chain not deployable: no gas funded (see config/token-config.json)");

        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        require(deployer == cfg.burner, "PRIVATE_KEY must be the burner deployer key");

        console.log("Deploying token:", cfg.name, cfg.symbol);
        console.log("Chain:", cfg.chainName);
        console.log("Chain ID:", cfg.chainId);
        console.log("Deployer (burner):", deployer);
        console.log("Agent holder:", cfg.agent);
        console.log("Router:", cfg.router);
        if (cfg.router == address(0)) {
            console.log("NOTE: no router configured - tax + burn work, buyback/LP stay inactive until setRouter()");
        }
        if (cfg.quoteToken != address(0)) {
            console.log("Quote token (ERC-20 path):", cfg.quoteToken);
        } else {
            console.log("Quote: native ETH path");
        }

        vm.startBroadcast(deployerKey);
        TaxToken token = new TaxToken(
            cfg.name,
            cfg.symbol,
            cfg.initialSupply,
            cfg.taxBps,
            cfg.burnShare,
            cfg.buybackShare,
            cfg.lpShare,
            cfg.router,
            cfg.quoteToken,
            deployer
        );
        uint256 allocation = (cfg.initialSupply * cfg.agentAllocationBps) / 10000;
        if (allocation > 0) {
            token.transfer(cfg.agent, allocation);
        }
        vm.stopBroadcast();

        console.log("Token deployed at:", address(token));
        console.log("Agent allocation:", allocation);

        // Build the receipt JSON incrementally (one big string.concat
        // overflows the stack: "stack too deep").
        string memory out = '{\n  "chainId": ';
        out = string.concat(out, vm.toString(cfg.chainId));
        out = string.concat(out, ',\n  "chain": "', cfg.chainName, '"');
        out = string.concat(out, ',\n  "token": "', vm.toString(address(token)), '"');
        out = string.concat(out, ',\n  "name": "', cfg.name, '"');
        out = string.concat(out, ',\n  "symbol": "', cfg.symbol, '"');
        out = string.concat(out, ',\n  "deployer": "', vm.toString(deployer), '"');
        out = string.concat(out, ',\n  "agent": "', vm.toString(cfg.agent), '"');
        out = string.concat(out, ',\n  "agentAllocation": "', vm.toString(allocation), '"');
        out = string.concat(out, ',\n  "router": "', vm.toString(cfg.router), '"');
        out = string.concat(out, ',\n  "quoteToken": "', vm.toString(cfg.quoteToken), '"\n}\n');
        string memory path = string.concat("deployments/", vm.toString(cfg.chainId), ".json");
        vm.writeFile(path, out);
        console.log("Wrote", path);
    }
}
