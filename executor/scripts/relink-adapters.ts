import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

loadEnv();

type DeploymentFile = {
  chainId: number;
  network: string;
  addresses: {
    aaveAdapter: string;
    swapAdapter: string;
    uniswapAdapter?: string;
    panikExecutor: string;
  };
};

const adapterAbi = [
  "function executor() view returns (address)",
  "function setExecutor(address executor_)",
];

function readDeploymentFile(): DeploymentFile {
  const deploymentPath = path.resolve(
    process.cwd(),
    "deploy",
    "addresses.base-sepolia.json"
  );
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Missing deployment file: ${deploymentPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as DeploymentFile;
  if (parsed.chainId !== 84532) {
    throw new Error(`Unexpected deployment chainId ${parsed.chainId}. Expected 84532.`);
  }

  return parsed;
}

async function bindIfNeeded(
  label: string,
  adapterAddress: string,
  expectedExecutor: string
): Promise<void> {
  const adapter = await ethers.getContractAt(adapterAbi, adapterAddress);
  const current = ethers.getAddress(await adapter.executor());
  const target = ethers.getAddress(expectedExecutor);

  if (current === target) {
    console.log(`${label}: already linked to ${target}`);
    return;
  }

  console.log(`${label}: relinking ${current} -> ${target}`);
  const tx = await adapter.setExecutor(target);
  await tx.wait();
  const verified = ethers.getAddress(await adapter.executor());
  if (verified !== target) {
    throw new Error(`${label}: relink failed, still points to ${verified}`);
  }
  console.log(`${label}: relinked successfully (${tx.hash})`);
}

async function main(): Promise<void> {
  const [signer] = await ethers.getSigners();
  if (!signer) {
    throw new Error(
      "No signer available. Set DEPLOYER_PRIVATE_KEY in .env to a valid private key."
    );
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 84532n) {
    throw new Error(`Wrong network chainId ${network.chainId}. Expected 84532.`);
  }

  const deployment = readDeploymentFile();
  const expectedExecutor = deployment.addresses.panikExecutor;

  console.log(`Signer: ${signer.address}`);
  console.log(`Target executor: ${expectedExecutor}`);

  await bindIfNeeded("AaveAdapter", deployment.addresses.aaveAdapter, expectedExecutor);
  await bindIfNeeded("SwapAdapter", deployment.addresses.swapAdapter, expectedExecutor);
  if (deployment.addresses.uniswapAdapter) {
    await bindIfNeeded(
      "UniswapAdapter",
      deployment.addresses.uniswapAdapter,
      expectedExecutor
    );
  }

  console.log("Adapter relink complete.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
