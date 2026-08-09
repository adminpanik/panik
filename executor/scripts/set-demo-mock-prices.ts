import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";

loadEnv();

// Base Sepolia demo prices for the mock oracle (Aave convention: 8 decimals).
// These back the v2 delegated slippage floor for assets that have no Chainlink
// feed on Base Sepolia and are therefore listed in MOCK_ORACLE_ASSETS.
const MOCK_ORACLE = "0x461B6f2Cf77AD1D4A2C51A33BB9a8C6449196D2a";
const PRICES: Array<{ label: string; asset: string; price: bigint }> = [
  { label: "WETH", asset: "0x4200000000000000000000000000000000000006", price: 3000_00000000n },
  { label: "USDC", asset: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", price: 1_00000000n },
  { label: "USDT", asset: "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a", price: 1_00000000n },
  { label: "LINK", asset: "0x810D46F9a9027E28F9B01F75E2bdde839dA61115", price: 15_00000000n },
  { label: "cbETH", asset: "0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B", price: 3200_00000000n },
];

const ABI = [
  "function setPrice(address asset, uint256 price) external",
  "function getAssetPrice(address asset) view returns (uint256)",
];

async function main(): Promise<void> {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 84532n) {
    throw new Error(`Wrong network chainId ${net.chainId}; expected 84532`);
  }
  const [deployer] = await ethers.getSigners();
  console.log(`Deployer: ${deployer.address}`);
  const oracle = await ethers.getContractAt(ABI, MOCK_ORACLE);
  for (const { label, asset, price } of PRICES) {
    const before = (await oracle.getAssetPrice(asset)) as bigint;
    if (before === price) {
      console.log(`${label} ${asset}: already ${before}, skip`);
      continue;
    }
    const tx = await oracle.setPrice(asset, price);
    const receipt = await tx.wait();
    const after = (await oracle.getAssetPrice(asset)) as bigint;
    console.log(`${label} ${asset}: ${before} -> ${after}  tx ${receipt?.hash ?? tx.hash}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
