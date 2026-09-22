import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import solc from "solc";
import { pathToFileURL } from "node:url";

export function compile() {
  const names = ["AAMBToken", "AAMBGovernor", "AAMBTaskEscrow"];
  const sources = Object.fromEntries(names.map(name => [`contracts/${name}.sol`, { content: readFileSync(`contracts/${name}.sol`, "utf8") }]));
  sources["contracts/Treasury.sol"] = { content: '// SPDX-License-Identifier: ISC\npragma solidity ^0.8.24;\nimport "@openzeppelin/contracts/governance/TimelockController.sol";' };
  const input = { language: "Solidity", sources, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"] } } } };
  const imported = {};
  const result = JSON.parse(solc.compile(JSON.stringify(input), { import: name => {
    if (!name.startsWith("@openzeppelin/contracts/") || name.includes("..")) return { error: "Unsupported import" };
    try { const contents = readFileSync(`node_modules/${name}`, "utf8"); imported[name] = { content: contents }; return { contents }; }
    catch { return { error: `Missing import ${name}` }; }
  } }));
  const errors = result.errors?.filter(e => e.severity === "error") || [];
  if (errors.length) throw Error(errors.map(e => e.formattedMessage).join("\n"));
  const artifacts = {};
  for (const contracts of Object.values(result.contracts)) {
    for (const [name, value] of Object.entries(contracts)) {
      if ([...names, "TimelockController"].includes(name)) artifacts[name] = { abi: value.abi, bytecode: "0x" + value.evm.bytecode.object, deployedBytecode: "0x" + value.evm.deployedBytecode.object, metadata: value.metadata };
    }
  }
  mkdirSync("build/dao", { recursive: true });
  writeFileSync("build/dao/artifacts.json", JSON.stringify(artifacts, null, 2) + "\n");
  writeFileSync("build/dao/standard-input.json", JSON.stringify({ ...input, sources: { ...sources, ...imported } }, null, 2) + "\n");
  writeFileSync("build/dao/compiler.json", JSON.stringify({ version: solc.version(), optimizerRuns: 200, evmVersion: "cancun" }, null, 2) + "\n");
  return artifacts;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const contracts = compile();
  console.log(JSON.stringify({ compiler: solc.version(), contracts: Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, (v.deployedBytecode.length - 2) / 2])) }, null, 2));
}
