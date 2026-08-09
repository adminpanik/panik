import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

loadEnv();

type DeploymentFile = {
  chainId: number;
  config: {
    usdc: string;
    mockOracle: string;
  };
};

const MOCK_ORACLE_ABI = [
  "function setPrice(address asset, uint256 price) external",
  "function getAssetPrice(address asset) view returns (uint256)",
];

function readDeployment(): DeploymentFile {
  const filePath = path.resolve(
    process.cwd(),
    "deploy",
    "addresses.base-sepolia.json"
  );
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing deployment file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as DeploymentFile;
}

function envOrDefaultBigint(name: string, fallback: bigint): bigint {
  const value = process.env[name];
  if (!value || value.trim() === "") return fallback;
  const parsed = BigInt(value.trim());
  if (parsed <= 0n) {
    throw new Error(`${name} must be > 0`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const deployment = readDeployment();
  if (deployment.chainId !== 84532) {
    throw new Error(`Wrong deployment chainId ${deployment.chainId}; expected 84532`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer available.");
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 84532n) {
    throw new Error(`Wrong network chainId ${network.chainId}; expected 84532`);
  }

  const mockOracleAddress = ethers.getAddress(deployment.config.mockOracle);
  const usdcOut = ethers.getAddress(deployment.config.usdc);

  // Aave oracle convention is typically 8 decimals.
  const usdcOutPrice = envOrDefaultBigint("MOCK_PRICE_USDC_OUT", 100_000_000n);

  const mockOracle = await ethers.getContractAt(MOCK_ORACLE_ABI, mockOracleAddress);
  const before = (await mockOracle.getAssetPrice(usdcOut)) as bigint;

  console.log(`Deployer: ${deployer.address}`);
  console.log(`MockOracle: ${mockOracleAddress}`);
  console.log(`USDC_OUT: ${usdcOut}`);
  console.log(`Price before: ${before.toString()}`);

  if (before === usdcOutPrice) {
    console.log("Mock price already set. No tx sent.");
    return;
  }

  const tx = await mockOracle.setPrice(usdcOut, usdcOutPrice);
  const receipt = await tx.wait();

  const after = (await mockOracle.getAssetPrice(usdcOut)) as bigint;
  console.log(`Price after: ${after.toString()}`);
  console.log(`Tx: ${receipt?.hash ?? tx.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

