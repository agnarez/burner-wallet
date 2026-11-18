import "dotenv/config";
import { defineConfig } from "hardhat/config";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

// Signer = the burner wallet (we hold its key). The Circle agent wallet is
// MPC-held by Circle — no exportable key — so it can never be a signer here,
// only a holder/recipient (see scripts/deploy.js mintTo).
const burnerAccounts =
  process.env.BURNER_PRIVATE_KEY !== undefined &&
  process.env.BURNER_PRIVATE_KEY !== ""
    ? [process.env.BURNER_PRIVATE_KEY]
    : [];

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          // Cancun EVM: OpenZeppelin 5.6 uses the `mcopy` builtin.
          evmVersion: "cancun",
        },
      },
      production: {
        version: "0.8.28",
        settings: {
          evmVersion: "cancun",
          optimizer: { enabled: true, runs: 200 },
        },
      },
    },
  },
  // Default network is Arc Testnet: it is the only chain where BOTH wallets
  // hold gas right now (USDC is Arc's gas token — burner 80, agent 20).
  defaultNetwork: "arcTestnet",
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainId: 31337,
    },
    arcTestnet: {
      type: "http",
      chainId: 5042002,
      url:
        process.env.ARC_TESTNET_RPC_URL ??
        "https://arc-testnet-rpc.publicnode.com",
      accounts: burnerAccounts,
    },
    sepolia: {
      type: "http",
      chainId: 11155111,
      url:
        process.env.SEPOLIA_RPC_URL ??
        "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: burnerAccounts,
    },
    baseSepolia: {
      type: "http",
      chainId: 84532,
      url:
        process.env.BASE_SEPOLIA_RPC_URL ??
        "https://base-sepolia-rpc.publicnode.com",
      accounts: burnerAccounts,
    },
    // Robinhood Chain testnet — public RPC verified live 2026-11-18:
    // https://rpc.testnet.chain.robinhood.com (chainId 46630).
    // Burner holds 0.01005 testnet ETH there; the agent wallet does not
    // exist on this chain.
    robinhoodTestnet: {
      type: "http",
      chainId: 46630,
      url:
        process.env.ROBINHOOD_TESTNET_RPC_URL ??
        "https://rpc.testnet.chain.robinhood.com",
      accounts: burnerAccounts,
    },
    // LitVM testnet ("LiteForge") — Litecoin's EVM rollup, Arbitrum
    // Orbit/Nitro stack. Verified 2026-11-18: chain ID 4441, gas token
    // zkLTC, RPC https://rpc.testnet.liteforge.zeeve.net/, explorer
    // https://explorer.testnet.liteforge.zeeve.net/. No zkLTC held by
    // either wallet yet — config only, deploy once gas is claimed.
    litvmTestnet: {
      type: "http",
      chainId: 4441,
      url:
        process.env.LITVM_TESTNET_RPC_URL ??
        "https://rpc.testnet.liteforge.zeeve.net/",
      accounts: burnerAccounts,
    },
  },
});
