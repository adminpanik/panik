import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";

loadEnv();

const AAVE_POOL = "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27";
const USDT = "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
];

const POOL_ABI = [
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 84532n) throw new Error("Wrong chain");

  const asset = process.env.SUPPLY_ASSET ?? USDT;
  const amountHuman = process.env.SUPPLY_AMOUNT ?? "1";

  const token = await ethers.getContractAt(ERC20_ABI, asset);
  const [symbol, decimals, balance] = await Promise.all([
    token.symbol(),
    token.decimals(),
    token.balanceOf(signer.address),
  ]);
  const amount = ethers.parseUnits(amountHuman, Number(decimals));

  console.log(`Signer: ${signer.address}`);
  console.log(`Asset: ${symbol} (${asset})`);
  console.log(`Amount: ${amountHuman} ${symbol}`);
  console.log(`Balance: ${ethers.formatUnits(balance, decimals)} ${symbol}`);

  if (balance < amount) {
    throw new Error(`Insufficient ${symbol} balance`);
  }

  // Approve with manual gas limit (bypasses "intrinsic gas too high")
  const allowance = (await token.allowance(signer.address, AAVE_POOL)) as bigint;
  if (allowance < amount) {
    console.log("Approving...");
    const approveTx = await token.approve(AAVE_POOL, amount, { gasLimit: 100_000 });
    await approveTx.wait();
    console.log("Approved.");
  }

  // Supply with manual gas limit
  console.log("Supplying to Aave...");
  const pool = await ethers.getContractAt(POOL_ABI, AAVE_POOL);
  const supplyTx = await pool.supply(asset, amount, signer.address, 0, { gasLimit: 300_000 });
  const receipt = await supplyTx.wait();
  console.log(`✅ Supplied ${amountHuman} ${symbol} to Aave. tx: ${receipt?.hash ?? supplyTx.hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
