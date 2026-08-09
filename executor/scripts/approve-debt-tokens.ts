import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

loadEnv();

const ERC20_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function symbol() view returns (string)",
];

type DeploymentFile = {
  chainId: number;
  addresses: {
    panikExecutor: string;
  };
  config: {
    usdc: string;
    trackedAssets?: string[];
    swapAssets?: string[];
    debtSwapAssets?: string[];
  };
};

function readDeploymentFile(): DeploymentFile {
  const deploymentPath = path.resolve(
    process.cwd(),
    "deploy",
    "addresses.base-sepolia.json"
  );
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Missing deployment file: ${deploymentPath}`);
  }
  return JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as DeploymentFile;
}

function csv(name: string): string[] {
  const value = process.env[name];
  if (!value || value.trim() === "") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function uniqueAddresses(values: string[]): string[] {
  const set = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!ethers.isAddress(v)) {
      throw new Error(`Invalid address: ${v}`);
    }
    const normalized = ethers.getAddress(v);
    if (set.has(normalized)) continue;
    set.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function main(): Promise<void> {
  const deployment = readDeploymentFile();
  if (deployment.chainId !== 84532) {
    throw new Error(`Wrong deployment chainId ${deployment.chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer available.");
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 84532n) {
    throw new Error(`Wrong network chainId ${network.chainId}; expected 84532`);
  }

  const spender = ethers.getAddress(deployment.addresses.panikExecutor);
  const usdc = ethers.getAddress(deployment.config.usdc);

  const overrideAssets = csv("APPROVE_ASSETS");
  const fallbackAssets = [
    usdc,
    ...(deployment.config.debtSwapAssets ?? []),
    ...(deployment.config.swapAssets ?? []),
    ...(deployment.config.trackedAssets ?? []),
  ];
  const candidateAssets = overrideAssets.length > 0 ? overrideAssets : fallbackAssets;
  const assets = uniqueAddresses(candidateAssets);

  if (assets.length === 0) {
    throw new Error(
      "No assets to approve. Set APPROVE_ASSETS in .env or ensure deployment config has swap/tracked assets."
    );
  }

  console.log(`Owner: ${deployer.address}`);
  console.log(`Spender (PanikExecutor): ${spender}`);
  console.log(`Approving ${assets.length} token(s)...`);

  let nextNonce = await ethers.provider.getTransactionCount(
    deployer.address,
    "pending"
  );

  for (const asset of assets) {
    const token = await ethers.getContractAt(ERC20_ABI, asset);
    const symbol = await token
      .symbol()
      .then((s: string) => s)
      .catch(() => asset.slice(0, 8));
    const currentAllowance = (await token.allowance(
      deployer.address,
      spender
    )) as bigint;

    if (currentAllowance === ethers.MaxUint256) {
      console.log(`- ${symbol} (${asset}) already max-approved`);
      continue;
    }

    const tx = await token.approve(spender, ethers.MaxUint256, {
      nonce: nextNonce++,
    });
    const receipt = await tx.wait();
    console.log(`- ${symbol} (${asset}) approved. tx=${receipt?.hash ?? tx.hash}`);
  }

  console.log("All done.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
