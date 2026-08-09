import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";

loadEnv();

const AAVE_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";

const POOL_ABI = [
  "function withdraw(address asset, uint256 amount, address to) external returns (uint256)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 84532n) throw new Error("Wrong chain");

  const asset = process.env.WITHDRAW_ASSET;
  if (!asset) throw new Error("Missing WITHDRAW_ASSET");

  console.log(`Withdrawing all supply of ${asset} for ${signer.address}...`);

  const pool = await ethers.getContractAt(POOL_ABI, AAVE_POOL);
  // Using ethers.MaxUint256 to withdraw everything
  const tx = await pool.withdraw(asset, ethers.MaxUint256, signer.address, { gasLimit: 500_000 });
  const receipt = await tx.wait();
  
  console.log(`✅ Withdrawn! tx: ${receipt?.hash ?? tx.hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
