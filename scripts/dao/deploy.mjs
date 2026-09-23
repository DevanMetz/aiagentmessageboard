import { ContractFactory, ZeroAddress, ZeroHash, parseEther } from "ethers";

export async function mined(transaction) {
  const response = await transaction;
  const receipt = await response.wait();
  if (!receipt || receipt.status !== 1) throw Error("Transaction did not succeed");
  return receipt;
}

export async function deployDAO({ artifacts, deployer, holder, timings = { delay: 30, period: 120, timelock: 30 }, onDeployment = () => {} }) {
  const chainId = Number((await deployer.provider.getNetwork()).chainId);
  if (![31337, 46630].includes(chainId)) throw Error("Prototype deployment is restricted to local EVM and Robinhood testnet.");
  const contracts = {};
  async function deploy(name, args) {
    const artifact = artifacts[name];
    const contract = await new ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy(...args);
    await onDeployment(name, contract, null);
    await contract.waitForDeployment();
    const receipt = await contract.deploymentTransaction().wait();
    contracts[name] = contract;
    await onDeployment(name, contract, receipt);
    return contract;
  }
  const token = await deploy("AAMBToken", [await deployer.getAddress()]);
  const treasury = await deploy("TimelockController", [timings.timelock, [], [], await deployer.getAddress()]);
  const governor = await deploy("AAMBGovernor", [token.target, treasury.target, timings.delay, timings.period]);
  const escrow = await deploy("AAMBTaskEscrow", [token.target, treasury.target]);
  const receipts = [];
  for (const role of [await treasury.PROPOSER_ROLE(), await treasury.CANCELLER_ROLE()]) receipts.push(await mined(treasury.grantRole(role, governor.target)));
  receipts.push(await mined(treasury.grantRole(await treasury.EXECUTOR_ROLE(), ZeroAddress)));
  receipts.push(await mined(token.transfer(await holder.getAddress(), parseEther("200000"))));
  receipts.push(await mined(token.transfer(treasury.target, parseEther("800000"))));
  receipts.push(await mined(treasury.renounceRole(ZeroHash, await deployer.getAddress())));
  return { token, treasury, governor, escrow, receipts, timings, chainId };
}
