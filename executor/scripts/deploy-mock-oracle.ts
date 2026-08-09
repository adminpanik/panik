import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

loadEnv();

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      "No deployer signer available. Set DEPLOYER_PRIVATE_KEY in .env to a valid 32-byte private key."
    );
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 84532n) {
    throw new Error(`Wrong network chainId ${network.chainId}. Expected 84532 (Base Sepolia).`);
  }

  console.log(`Deployer: ${deployer.address}`);
  console.log("Deploying MockPriceOracle...");

  const MockPriceOracle = await ethers.getContractFactory("MockPriceOracle");
  const mockOracle = await MockPriceOracle.deploy();
  await mockOracle.waitForDeployment();

  const address = await mockOracle.getAddress();
  console.log(`MockPriceOracle deployed at: ${address}`);

  const outputDir = path.resolve(process.cwd(), "deploy");
  fs.mkdirSync(outputDir, { recursive: true });
  const outputFile = path.join(outputDir, "mock-oracle.base-sepolia.json");
  fs.writeFileSync(
    outputFile,
    JSON.stringify(
      {
        chainId: 84532,
        network: "baseSepolia",
        deployedAt: new Date().toISOString(),
        deployer: deployer.address,
        mockOracle: address,
      },
      null,
      2
    )
  );
  console.log(`Saved: ${outputFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
