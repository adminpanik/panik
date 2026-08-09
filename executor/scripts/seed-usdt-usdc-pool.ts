import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";

loadEnv();

const BASE_SEPOLIA_CHAIN_ID = 84532n;
const FACTORY = "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
const NPM = "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2";
const FEE = 500;

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

const NPM_ABI = [
  "function factory() view returns (address)",
  "function createAndInitializePoolIfNecessary(address tokenA,address tokenB,uint24 fee,uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return fallback;
  return value.trim();
}

function sortTokens(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function sqrt(value: bigint): bigint {
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + value / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

function encodeSqrtRatioX96(amount1: bigint, amount0: bigint): bigint {
  const ratioX192 = (amount1 << 192n) / amount0;
  return sqrt(ratioX192);
}

async function ensureAllowance(
  tokenAddress: string,
  owner: string,
  spender: string,
  required: bigint
) {
  const token = await ethers.getContractAt(ERC20_ABI, tokenAddress);
  const allowance = (await token.allowance(owner, spender)) as bigint;
  if (allowance >= required) return;
  const tx = await token.approve(spender, required);
  await tx.wait();
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer available.");

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`Wrong chain ${network.chainId}. Expected ${BASE_SEPOLIA_CHAIN_ID}.`);
  }

  const usdc = requiredEnv("USDC");
  const usdt = envOrDefault("USDT", "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a");

  const seedUsdt = envOrDefault("USDT_USDC_SEED_USDT", "1000");
  const seedUsdc = envOrDefault("USDT_USDC_SEED_USDC", "1000");

  const usdtToken = await ethers.getContractAt(ERC20_ABI, usdt);
  const usdcToken = await ethers.getContractAt(ERC20_ABI, usdc);
  const [usdtDecimals, usdcDecimals, usdtSymbol, usdcSymbol] = await Promise.all([
    usdtToken.decimals(),
    usdcToken.decimals(),
    usdtToken.symbol(),
    usdcToken.symbol(),
  ]);

  const amountUsdt = ethers.parseUnits(seedUsdt, Number(usdtDecimals));
  const amountUsdc = ethers.parseUnits(seedUsdc, Number(usdcDecimals));

  const [balanceUsdt, balanceUsdc] = await Promise.all([
    usdtToken.balanceOf(deployer.address),
    usdcToken.balanceOf(deployer.address),
  ]);

  console.log(`deployer: ${deployer.address}`);
  console.log(`seed request: ${seedUsdt} ${usdtSymbol} + ${seedUsdc} ${usdcSymbol}`);
  console.log(`wallet: ${ethers.formatUnits(balanceUsdt, usdtDecimals)} ${usdtSymbol}`);
  console.log(`wallet: ${ethers.formatUnits(balanceUsdc, usdcDecimals)} ${usdcSymbol}`);

  if (balanceUsdt < amountUsdt) {
    throw new Error(`Insufficient ${usdtSymbol} for seed amount.`);
  }
  if (balanceUsdc < amountUsdc) {
    throw new Error(`Insufficient ${usdcSymbol} for seed amount.`);
  }

  const factory = await ethers.getContractAt(FACTORY_ABI, FACTORY);
  const npm = await ethers.getContractAt(NPM_ABI, NPM);
  const npmFactory = await npm.factory();
  if (npmFactory.toLowerCase() !== FACTORY.toLowerCase()) {
    throw new Error(`NPM factory mismatch: ${npmFactory}`);
  }

  await ensureAllowance(usdt, deployer.address, NPM, amountUsdt);
  await ensureAllowance(usdc, deployer.address, NPM, amountUsdc);

  const [token0, token1] = sortTokens(usdt, usdc);
  const amount0Desired = token0.toLowerCase() === usdt.toLowerCase() ? amountUsdt : amountUsdc;
  const amount1Desired = token1.toLowerCase() === usdt.toLowerCase() ? amountUsdt : amountUsdc;

  let pool = await factory.getPool(token0, token1, FEE);
  if (pool === ethers.ZeroAddress) {
    const price1to1 = encodeSqrtRatioX96(1n, 1n);
    const tx = await npm.createAndInitializePoolIfNecessary(token0, token1, FEE, price1to1);
    await tx.wait();
    pool = await factory.getPool(token0, token1, FEE);
  }

  const deadline = Math.floor(Date.now() / 1000) + 1200;
  const tx = await npm.mint({
    token0,
    token1,
    fee: FEE,
    tickLower: -887270,
    tickUpper: 887270,
    amount0Desired,
    amount1Desired,
    amount0Min: 0,
    amount1Min: 0,
    recipient: deployer.address,
    deadline,
  });
  const receipt = await tx.wait();
  console.log(`seed tx: ${receipt?.hash ?? tx.hash}`);
  console.log(`pool: ${pool}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

