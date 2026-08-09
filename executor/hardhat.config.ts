import { config as loadEnv } from "dotenv";
import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";

loadEnv();

function resolveDeployerAccounts(): string[] {
  const raw = process.env.DEPLOYER_PRIVATE_KEY?.trim();
  if (!raw) return [];
  if (/^0x[a-fA-F0-9]{64}$/.test(raw)) return [raw];
  if (/^[a-fA-F0-9]{64}$/.test(raw)) return [`0x${raw}`];
  return [];
}

const deployerAccounts = resolveDeployerAccounts();

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // The Sepolia deployment was compiled to paris (Hardhat's implicit
      // default for solc 0.8.24). Pinned so a toolchain upgrade cannot
      // silently retarget codegen and break bytecode reproducibility.
      evmVersion: "paris",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      // Base mainnet fork for test/fork/*.fork.spec.ts - the mainnet-readiness
      // proof. Enable with: BASE_MAINNET_RPC=<alchemy url> npx hardhat test test/fork
      ...(process.env.BASE_MAINNET_RPC
        ? {
            chainId: 8453,
            chains: {
              8453: { hardforkHistory: { cancun: 0 } },
            },
            forking: {
              url: process.env.BASE_MAINNET_RPC,
              // Pinned to a recent finalized Base mainnet block so fork runs are
              // deterministic and Alchemy-cached (forking from `latest` is not
              // repeatable and warns). Captured 2026-08-10 (chain head was
              // ~0x2f73cf8 / 49,691,384). Override with FORK_BLOCK_NUMBER.
              blockNumber: process.env.FORK_BLOCK_NUMBER
                ? Number(process.env.FORK_BLOCK_NUMBER)
                : 49_691_000,
            },
          }
        : {}),
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: deployerAccounts,
    },
  },
};

export default config;
