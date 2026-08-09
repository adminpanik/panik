import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";

loadEnv();

const BASE_SEPOLIA_CHAIN_ID = 84532n;
const UNISWAP_V3_FACTORY_BASE_SEPOLIA =
  "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24";
const NONFUNGIBLE_POSITION_MANAGER_BASE_SEPOLIA =
  "0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2";

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

type SeedTarget = {
  label: string;
  tokenA: string;
  tokenB: string;
  fee: number;
  amountADesired: bigint;
  amountBDesired: bigint;
  priceTokenBPerTokenA_num: bigint;
  priceTokenBPerTokenA_den: bigint;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    return fallback;
  }
  return value.trim();
}

function sortTokens(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

function minTickForFee(fee: number): number {
  if (fee === 500) return -887270;
  if (fee === 3000) return -887220;
  if (fee === 10000) return -887200;
  throw new Error(`Unsupported fee tier for tick range: ${fee}`);
}

function maxTickForFee(fee: number): number {
  if (fee === 500) return 887270;
  if (fee === 3000) return 887220;
  if (fee === 10000) return 887200;
  throw new Error(`Unsupported fee tier for tick range: ${fee}`);
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

  const numerator = amount1 << 192n;
  const ratioX192 = numerator / amount0;
  return sqrt(ratioX192);
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
    throw new Error(
      `Wrong chain ${network.chainId}. Expected ${BASE_SEPOLIA_CHAIN_ID}.`
    );
  }

  const usdc = requiredEnv("USDC");
  const usdt = envOrDefault(
    "USDT",
    "0x0a215D8ba66387DCA84B284D18c3B4ec3de6E54a"
  );
  const link = envOrDefault(
    "LINK",
    "0x810D46F9a9027E28F9B01F75E2bdde839dA61115"
  );

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

  const targets: SeedTarget[] = [
    {
      label: "USDT/USDC (fee 500)",
      tokenA: usdt,
      tokenB: usdc,
      fee: 500,
      amountADesired: ethers.parseUnits("0.25", 6), // USDT
      amountBDesired: ethers.parseUnits("0.25", 6), // USDC
      priceTokenBPerTokenA_num: 1n,
      priceTokenBPerTokenA_den: 1n,
    },
    {
      label: "LINK/USDC (fee 3000)",
      tokenA: link,
      tokenB: usdc,
      fee: 3000,
      amountADesired: ethers.parseUnits("0.005", 18), // LINK
      amountBDesired: ethers.parseUnits("0.08", 6), // USDC
      // 1 LINK ~= 16 USDC (rough demo seed ratio)
      priceTokenBPerTokenA_num: 16n,
      priceTokenBPerTokenA_den: 1n,
    },
  ];

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Factory: ${UNISWAP_V3_FACTORY_BASE_SEPOLIA}`);
  console.log(`NPM: ${NONFUNGIBLE_POSITION_MANAGER_BASE_SEPOLIA}`);
  let nextNonce = await ethers.provider.getTransactionCount(
    deployer.address,
    "pending"
  );

  for (const target of targets) {
    const tokenA = await ethers.getContractAt(ERC20_ABI, target.tokenA);
    const tokenB = await ethers.getContractAt(ERC20_ABI, target.tokenB);
    const symbolA = (await tokenA.symbol()) as string;
    const symbolB = (await tokenB.symbol()) as string;
    const decimalsA = Number(await tokenA.decimals());
    const decimalsB = Number(await tokenB.decimals());
    const balanceA = (await tokenA.balanceOf(deployer.address)) as bigint;
    const balanceB = (await tokenB.balanceOf(deployer.address)) as bigint;

    console.log(`\nSeeding ${target.label}`);
    console.log(
      `Balances: ${symbolA}=${ethers.formatUnits(
        balanceA,
        decimalsA
      )}, ${symbolB}=${ethers.formatUnits(balanceB, decimalsB)}`
    );

    if (balanceA < target.amountADesired) {
      throw new Error(
        `Insufficient ${symbolA}. need=${ethers.formatUnits(
          target.amountADesired,
          decimalsA
        )} have=${ethers.formatUnits(balanceA, decimalsA)}`
      );
    }
    if (balanceB < target.amountBDesired) {
      throw new Error(
        `Insufficient ${symbolB}. need=${ethers.formatUnits(
          target.amountBDesired,
          decimalsB
        )} have=${ethers.formatUnits(balanceB, decimalsB)}`
      );
    }

    nextNonce = await ensureAllowance(
      target.tokenA,
      deployer.address,
      NONFUNGIBLE_POSITION_MANAGER_BASE_SEPOLIA,
      target.amountADesired,
      nextNonce
    );
    nextNonce = await ensureAllowance(
      target.tokenB,
      deployer.address,
      NONFUNGIBLE_POSITION_MANAGER_BASE_SEPOLIA,
      target.amountBDesired,
      nextNonce
    );

    const [token0, token1] = sortTokens(target.tokenA, target.tokenB);
    const decimals0 = token0.toLowerCase() === target.tokenA.toLowerCase() ? decimalsA : decimalsB;
    const decimals1 = token1.toLowerCase() === target.tokenA.toLowerCase() ? decimalsA : decimalsB;

    const amountAInToken0 =
      token0.toLowerCase() === target.tokenA.toLowerCase()
        ? target.amountADesired
        : target.amountBDesired;
    const amountBInToken1 =
      token1.toLowerCase() === target.tokenA.toLowerCase()
        ? target.amountADesired
        : target.amountBDesired;

    // target price is tokenB per tokenA in human units. Convert to raw units token1/token0.
    const priceToken1PerToken0_num =
      token1.toLowerCase() === target.tokenB.toLowerCase()
        ? target.priceTokenBPerTokenA_num
        : target.priceTokenBPerTokenA_den;
    const priceToken1PerToken0_den =
      token1.toLowerCase() === target.tokenB.toLowerCase()
        ? target.priceTokenBPerTokenA_den
        : target.priceTokenBPerTokenA_num;

    const rawAmount1ForPrice =
      priceToken1PerToken0_num * 10n ** BigInt(decimals1);
    const rawAmount0ForPrice =
      priceToken1PerToken0_den * 10n ** BigInt(decimals0);
    const sqrtPriceX96 = encodeSqrtRatioX96(rawAmount1ForPrice, rawAmount0ForPrice);

    const poolBefore = (await factory.getPool(
      token0,
      token1,
      target.fee
    )) as string;
    if (poolBefore === ethers.ZeroAddress) {
      const createTx = await npm.createAndInitializePoolIfNecessary(
        token0,
        token1,
        target.fee,
        sqrtPriceX96,
        { nonce: nextNonce++ }
      );
      await createTx.wait();
    }

    const tickLower = minTickForFee(target.fee);
    const tickUpper = maxTickForFee(target.fee);
    const deadline = Math.floor(Date.now() / 1000) + 1_200;

    const mintTx = await npm.mint(
      {
        token0,
        token1,
        fee: target.fee,
        tickLower,
        tickUpper,
        amount0Desired: amountAInToken0,
        amount1Desired: amountBInToken1,
        amount0Min: 0,
        amount1Min: 0,
        recipient: deployer.address,
        deadline,
      },
      { nonce: nextNonce++ }
    );
    const receipt = await mintTx.wait();

    const poolAfter = (await factory.getPool(
      token0,
      token1,
      target.fee
    )) as string;
    console.log(
      `Seeded ${target.label}. pool=${poolAfter} tx=${receipt?.hash ?? mintTx.hash}`
    );
  }

  console.log("\nDone seeding target pools.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
