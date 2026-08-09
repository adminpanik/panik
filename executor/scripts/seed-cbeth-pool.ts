import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";

loadEnv();

const BASE_SEPOLIA_CHAIN_ID = 84532n;
const UNISWAP_V3_FACTORY_BASE_SEPOLIA =
  "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
const NONFUNGIBLE_POSITION_MANAGER_BASE_SEPOLIA =
  "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2";
const CBETH_BASE_SEPOLIA = "0xD171b9694f7A2597Ed006D41f7509aaD4B485c4B";
const FEE = 3000;

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
];

const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address tokenA,address tokenB,uint24 fee,uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function factory() view returns (address)",
];

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
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
  if (amount0 === 0n || amount1 === 0n) {
    throw new Error("encodeSqrtRatioX96 requires non-zero amounts");
  }
  const ratioX192 = (amount1 << 192n) / amount0;
  return sqrt(ratioX192);
}

function minTick(): number {
  return -887220;
}

function maxTick(): number {
  return 887220;
}

async function ensureAllowance(
  tokenAddress: string,
  owner: string,
  spender: string,
  required: bigint,
  nonce: number
): Promise<number> {
  const token = await ethers.getContractAt(ERC20_ABI, tokenAddress);
  const current = (await token.allowance(owner, spender)) as bigint;
  if (current >= required) {
    return nonce;
  }

  const tx = await token.approve(spender, required, { nonce });
  await tx.wait();
  return nonce + 1;
}

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer available.");
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`Wrong chain ${network.chainId}. Expected ${BASE_SEPOLIA_CHAIN_ID}.`);
  }

  const usdc = requiredEnv("USDC");
  const cbeth = process.env.CBETH?.trim() || CBETH_BASE_SEPOLIA;

  const factory = await ethers.getContractAt(
    FACTORY_ABI,
    UNISWAP_V3_FACTORY_BASE_SEPOLIA
  );
  const npm = await ethers.getContractAt(
    NPM_ABI,
    NONFUNGIBLE_POSITION_MANAGER_BASE_SEPOLIA
  );

  const npmFactory = (await npm.factory()) as string;
  if (
    npmFactory.toLowerCase() !==
    UNISWAP_V3_FACTORY_BASE_SEPOLIA.toLowerCase()
  ) {
    throw new Error(
      `NPM factory mismatch. expected=${UNISWAP_V3_FACTORY_BASE_SEPOLIA} actual=${npmFactory}`
    );
  }

  const cbethToken = await ethers.getContractAt(ERC20_ABI, cbeth);
  const usdcToken = await ethers.getContractAt(ERC20_ABI, usdc);
  const cbethDecimals = Number(await cbethToken.decimals());
  const usdcDecimals = Number(await usdcToken.decimals());

  const cbethBalance = (await cbethToken.balanceOf(deployer.address)) as bigint;
  const usdcBalance = (await usdcToken.balanceOf(deployer.address)) as bigint;

  // Keep seeding tiny but non-zero for demo route activation.
  const cbethDesired = cbethBalance;
  const usdcDesired = usdcBalance >= ethers.parseUnits("0.01", usdcDecimals)
    ? ethers.parseUnits("0.01", usdcDecimals)
    : usdcBalance;

  if (cbethDesired === 0n) {
    throw new Error("No cbETH balance available to seed pool.");
  }
  if (usdcDesired === 0n) {
    throw new Error("No USDC balance available to seed pool.");
  }

  console.log(`Deployer: ${deployer.address}`);
  console.log(`cbETH balance: ${ethers.formatUnits(cbethBalance, cbethDecimals)}`);
  console.log(`USDC balance: ${ethers.formatUnits(usdcBalance, usdcDecimals)}`);
  console.log(
    `Seeding with cbETH=${ethers.formatUnits(cbethDesired, cbethDecimals)} USDC=${ethers.formatUnits(usdcDesired, usdcDecimals)}`
  );

  let nextNonce = await ethers.provider.getTransactionCount(
    deployer.address,
    "pending"
  );

  nextNonce = await ensureAllowance(
    cbeth,
    deployer.address,
    NONFUNGIBLE_POSITION_MANAGER_BASE_SEPOLIA,
    cbethDesired,
    nextNonce
  );
  nextNonce = await ensureAllowance(
    usdc,
    deployer.address,
    NONFUNGIBLE_POSITION_MANAGER_BASE_SEPOLIA,
    usdcDesired,
    nextNonce
  );

  const [token0, token1] = sortTokens(cbeth, usdc);
  const amount0Desired = token0.toLowerCase() === cbeth.toLowerCase() ? cbethDesired : usdcDesired;
  const amount1Desired = token1.toLowerCase() === cbeth.toLowerCase() ? cbethDesired : usdcDesired;
  const decimals0 = token0.toLowerCase() === cbeth.toLowerCase() ? cbethDecimals : usdcDecimals;
  const decimals1 = token1.toLowerCase() === cbeth.toLowerCase() ? cbethDecimals : usdcDecimals;

  // Price target: 1 cbETH ~= 3500 USDC.
  const cbethPriceNum = 3500n;
  const cbethPriceDen = 1n;
  const priceToken1PerToken0_num =
    token1.toLowerCase() === usdc.toLowerCase() ? cbethPriceNum : cbethPriceDen;
  const priceToken1PerToken0_den =
    token1.toLowerCase() === usdc.toLowerCase() ? cbethPriceDen : cbethPriceNum;

  const rawAmount1ForPrice = priceToken1PerToken0_num * 10n ** BigInt(decimals1);
  const rawAmount0ForPrice = priceToken1PerToken0_den * 10n ** BigInt(decimals0);
  const sqrtPriceX96 = encodeSqrtRatioX96(rawAmount1ForPrice, rawAmount0ForPrice);

  const poolBefore = (await factory.getPool(token0, token1, FEE)) as string;
  if (poolBefore === ethers.ZeroAddress) {
    const tx = await npm.createAndInitializePoolIfNecessary(
      token0,
      token1,
      FEE,
      sqrtPriceX96,
      { nonce: nextNonce++ }
    );
    await tx.wait();
  }

  const deadline = Math.floor(Date.now() / 1000) + 1_200;
  const mintTx = await npm.mint(
    {
      token0,
      token1,
      fee: FEE,
      tickLower: minTick(),
      tickUpper: maxTick(),
      amount0Desired,
      amount1Desired,
      amount0Min: 0,
      amount1Min: 0,
      recipient: deployer.address,
      deadline,
    },
    { nonce: nextNonce++ }
  );
  const receipt = await mintTx.wait();
  const poolAfter = (await factory.getPool(token0, token1, FEE)) as string;

  console.log(`Seeded cbETH/USDC pool: ${poolAfter}`);
  console.log(`Tx: ${receipt?.hash ?? mintTx.hash}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

