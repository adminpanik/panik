import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";

loadEnv();

const AAVE_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const USDT = "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
];

const POOL_ABI = [
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external",
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 84532n) throw new Error("Wrong chain");

  const asset = process.env.BORROW_ASSET ?? USDT;
  const amountHuman = process.env.BORROW_AMOUNT ?? "0.5";
  const rateMode = Number(process.env.RATE_MODE ?? "2"); // 2 = variable

  const token = await ethers.getContractAt(ERC20_ABI, asset);
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  const amount = ethers.parseUnits(amountHuman, Number(decimals));

  const pool = await ethers.getContractAt(POOL_ABI, AAVE_POOL);
  const accountData = await pool.getUserAccountData(signer.address);

  console.log(`Signer: ${signer.address}`);
  console.log(`Borrow: ${amountHuman} ${symbol} (${asset})`);
  console.log(`Rate mode: ${rateMode === 2 ? "variable" : "stable"}`);
  console.log(`Collateral (USD): ${ethers.formatUnits(accountData[0], 8)}`);
  console.log(`Debt (USD): ${ethers.formatUnits(accountData[1], 8)}`);
  console.log(`Available borrows (USD): ${ethers.formatUnits(accountData[2], 8)}`);
  console.log(`Health factor: ${ethers.formatUnits(accountData[5], 18)}`);

  if (accountData[2] === 0n) {
    throw new Error("No borrowing capacity. Supply collateral first.");
  }

  console.log("Borrowing...");
  const tx = await pool.borrow(asset, amount, rateMode, 0, signer.address, { gasLimit: 500_000 });
  const receipt = await tx.wait();
  console.log(`✅ Borrowed ${amountHuman} ${symbol}. tx: ${receipt?.hash ?? tx.hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
