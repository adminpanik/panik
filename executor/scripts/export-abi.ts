import fs from "node:fs";
import path from "node:path";

const contracts = [
  {
    name: "PanikExecutor",
    artifactRelPath: path.join("contracts", "PanikExecutor.sol", "PanikExecutor.json"),
  },
  {
    name: "LockChecker",
    artifactRelPath: path.join("contracts", "LockChecker.sol", "LockChecker.json"),
  },
  {
    name: "AaveAdapter",
    artifactRelPath: path.join("contracts", "adapters", "AaveAdapter.sol", "AaveAdapter.json"),
  },
  {
    name: "SwapAdapter",
    artifactRelPath: path.join("contracts", "adapters", "SwapAdapter.sol", "SwapAdapter.json"),
  },
  {
    name: "MockPriceOracle",
    artifactRelPath: path.join("contracts", "mocks", "MockPriceOracle.sol", "MockPriceOracle.json"),
  },
] as const;

function main(): void {
  const root = process.cwd();
  const outDir = path.resolve(root, "abi");
  fs.mkdirSync(outDir, { recursive: true });

  for (const contract of contracts) {
    const artifactPath = path.resolve(root, "artifacts", contract.artifactRelPath);

    if (!fs.existsSync(artifactPath)) {
      throw new Error(
        `Artifact not found for ${contract.name}. Run 'npm run build' first. Missing: ${artifactPath}`
      );
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
      abi: unknown;
    };
    const outFile = path.join(outDir, `${contract.name}.json`);
    fs.writeFileSync(outFile, JSON.stringify(artifact.abi, null, 2));
  }

  console.log(`Exported ABIs to ${outDir}`);
}

main();
