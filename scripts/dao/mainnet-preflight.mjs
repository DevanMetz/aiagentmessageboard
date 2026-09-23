// Read-only: no private key, signer, approvals, contract deployment, or liquidity transaction.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { Contract, JsonRpcProvider, keccak256, parseEther } from "ethers";

const plan = JSON.parse(readFileSync("deployments/mainnet-plan.json", "utf8"));
assert.equal(plan.deploymentAuthorized, false, "This tool prepares a draft only.");
assert.equal(plan.allocations.reduce((total, item) => total + item.percent, 0), 100);
assert.equal(plan.allocations.reduce((total, item) => total + parseEther(item.tokens), 0n), parseEther(plan.proposedSupply));
const provider = new JsonRpcProvider(process.env.AAMB_MAINNET_RPC_URL || plan.rpcUrl, undefined, { cacheTimeout: -1 });
try {
  assert.equal(Number((await provider.getNetwork()).chainId), 4663);
  const block = await provider.getBlockNumber(), contracts = {};
  for (const key of ["factory", "positionManager", "quoteToken", "wrappedNative"]) {
    const address = plan.liquidity[key], code = await provider.getCode(address, block);
    assert.notEqual(code, "0x", `${key} has no code.`);
    contracts[key] = { address, runtimeCodeHash: keccak256(code) };
  }
  const manager = new Contract(plan.liquidity.positionManager, ["function factory() view returns(address)", "function WETH9() view returns(address)"], provider);
  assert.equal((await manager.factory()).toLowerCase(), plan.liquidity.factory.toLowerCase());
  assert.equal((await manager.WETH9()).toLowerCase(), plan.liquidity.wrappedNative.toLowerCase());
  const factory = new Contract(plan.liquidity.factory, ["function feeAmountTickSpacing(uint24) view returns(int24)"], provider);
  const spacing = Number(await factory.feeAmountTickSpacing(plan.liquidity.proposedFeeTier));
  assert.ok(spacing > 0, "Proposed pool fee tier is not enabled.");
  const quote = new Contract(plan.liquidity.quoteToken, ["function symbol() view returns(string)", "function decimals() view returns(uint8)"], provider);
  assert.equal(await quote.symbol(), plan.liquidity.quoteSymbol);
  const report = {
    checkedAt: new Date().toISOString(), chainId: 4663, blockNumber: block, readOnly: true,
    contracts, quoteDecimals: Number(await quote.decimals()), tickSpacing: spacing,
    fullRangeTicks: [Math.ceil(-887272 / spacing) * spacing, Math.floor(887272 / spacing) * spacing],
    allocationTotal: plan.proposedSupply, readyToDeploy: false,
    remaining: [...(!plan.distributionApproved ? ["Owner-approved allocation"] : []), "Distribution eligibility, supply confirmation and recipient list", "Jurisdiction, legal operator and reviewed public terms", "Fresh custody signers", "Reviewed vesting/distribution contracts and final cliff details", "Independent contract review and explorer source verification", "Owner-approved quote-asset and gas budgets", "Final deployment and liquidity transaction simulation", "Explicit mainnet launch authorization"],
    limitations: "Address/code existence and contract relationships checked against the documented deployment. This is not a DEX audit, price quote, liquidity guarantee, or authorization to transact. Recheck at execution time.",
  };
  writeFileSync("reports/dao-mainnet-preflight.json", JSON.stringify(report, null, 2) + "\n");
  console.log(`Read-only mainnet checks passed at block ${block}. ${report.remaining.length} launch decisions/checks remain; no transaction was signed.`);
} finally { provider.destroy(); }
