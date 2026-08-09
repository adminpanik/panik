import { config as loadEnv } from "dotenv";
import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";

loadEnv();

type DeploymentFile = {
  chainId: number;
  addresses: {
    panikExecutor: string;
  };
  config: {
    dataProvider: string;
  };
};

const DATA_PROVIDER_ABI = [
  "function getAllReservesTokens() view returns ((string symbol,address tokenAddress)[])",
  "function getUserReserveData(address asset,address user) view returns (uint256 currentATokenBalance,uint256 currentStableDebt,uint256 currentVariableDebt,uint256 principalStableDebt,uint256 scaledVariableDebt,uint256 stableBorrowRate,uint256 liquidityRate,uint40 stableRateLastUpdated,bool usageAsCollateralEnabled)",
  "function getReserveTokensAddresses(address asset) view returns (address aTokenAddress,address stableDebtTokenAddress,address variableDebtTokenAddress)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
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

  return JSON.parse(fs.readFileSync(deploymentPath, "utf8")) as DeploymentFile;
}

async function main(): Promise<void> {
  const deployment = readDeploymentFile();
  if (deployment.chainId !== 84532) {
    throw new Error(`Wrong deployment chainId: ${deployment.chainId}`);
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No deployer signer available.");
  }

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 84532n) {
    throw new Error(`Wrong network chainId ${network.chainId}; expected 84532`);
  }

  const spender = ethers.getAddress(deployment.addresses.panikExecutor);
  const dataProviderAddress = ethers.getAddress(deployment.config.dataProvider);
  const dataProvider = await ethers.getContractAt(
    DATA_PROVIDER_ABI,
    dataProviderAddress
  );

  const reserves =
    (await dataProvider.getAllReservesTokens()) as Array<{
      symbol: string;
      tokenAddress: string;
    }>;

  console.log(`Owner: ${deployer.address}`);
  console.log(`Spender (PanikExecutor): ${spender}`);
  console.log("Checking supplied reserves for missing aToken approvals...");

  let nextNonce = await ethers.provider.getTransactionCount(
    deployer.address,
    "pending"
  );
  let approvalsSent = 0;

  for (const reserve of reserves) {
    const reserveData = (await dataProvider.getUserReserveData(
      reserve.tokenAddress,
      deployer.address
    )) as { currentATokenBalance: bigint };

    if (reserveData.currentATokenBalance === 0n) {
      continue;
    }

    const reserveTokens = (await dataProvider.getReserveTokensAddresses(
      reserve.tokenAddress
    )) as {
      aTokenAddress: string;
    };

    const aToken = await ethers.getContractAt(
      ERC20_ABI,
      reserveTokens.aTokenAddress
    );
    const aTokenSymbol = await aToken
      .symbol()
      .then((value: string) => value)
      .catch(() => "aToken");

    const allowance = (await aToken.allowance(
      deployer.address,
      spender
    )) as bigint;

    if (allowance === ethers.MaxUint256) {
      console.log(
        `- ${reserve.symbol} collateral (${aTokenSymbol}) already max-approved`
      );
      continue;
    }

    const tx = await aToken.approve(spender, ethers.MaxUint256, {
      nonce: nextNonce++,
    });
    const receipt = await tx.wait();
    approvalsSent += 1;
    console.log(
      `- Approved ${aTokenSymbol} for ${reserve.symbol} collateral. tx=${receipt?.hash ?? tx.hash}`
    );
  }

  if (approvalsSent === 0) {
    console.log("No new aToken approvals were needed.");
  } else {
    console.log(`Completed ${approvalsSent} aToken approval transaction(s).`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

