import { AbiCoder, Interface, id, keccak256 } from "ethers";

export const tokenInterface = new Interface([
  "function delegate(address delegatee)", "function delegates(address) view returns(address)",
  "function getVotes(address) view returns(uint256)", "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
]);
export const governorInterface = new Interface([
  "function propose(address[],uint256[],bytes[],string) returns(uint256)",
  "function castVote(uint256,uint8) returns(uint256)",
  "function queue(address[],uint256[],bytes[],bytes32) returns(uint256)",
  "function execute(address[],uint256[],bytes[],bytes32) payable returns(uint256)",
  "function state(uint256) view returns(uint8)", "function proposalSnapshot(uint256) view returns(uint256)",
  "function proposalDeadline(uint256) view returns(uint256)", "function proposalEta(uint256) view returns(uint256)",
  "function proposalVotes(uint256) view returns(uint256 againstVotes,uint256 forVotes,uint256 abstainVotes)",
]);
export const escrowInterface = new Interface([
  "function fundTask(bytes32,uint256,address,uint64,bytes32)", "function claimTask(bytes32,uint64)",
  "function releaseTask(bytes32)", "function submitWork(bytes32,bytes32)",
  "function approveWork(bytes32,bytes32)", "function rejectWork(bytes32,bytes32)", "function refundExpired(bytes32)",
  "function tasks(bytes32) view returns(uint256 reward,address reviewer,address worker,uint64 deadline,uint64 claimExpiresAt,bytes32 specificationHash,bytes32 evidenceHash,uint8 status)",
]);
export const proposalStates = ["Pending", "Active", "Canceled", "Defeated", "Succeeded", "Queued", "Expired", "Executed"];
export const taskStates = ["Unfunded", "Funded", "Claimed", "Submitted", "Paid", "Refunded"];
export type DAODeployment = {
  name: string; symbol: string; network: string; chainId: number; rpcUrl: string; explorerUrl: string;
  deployed: boolean; token?: string; governor?: string; treasury?: string; escrow?: string; deploymentBlock?: number;
  boardOrigin?: string;
};
export function proposalActions(config: DAODeployment, taskId: string, amount: string, reviewer: string, deadline: number, specificationHash: string) {
  return {
    targets: [config.token!, config.escrow!], values: ["0", "0"],
    calldatas: [tokenInterface.encodeFunctionData("approve", [config.escrow, amount]), escrowInterface.encodeFunctionData("fundTask", [taskId, amount, reviewer, deadline, specificationHash])],
  };
}
export function proposalIdentity(actions: ReturnType<typeof proposalActions>, description: string) {
  const descriptionHash = id(description);
  const proposalId = BigInt(keccak256(AbiCoder.defaultAbiCoder().encode(["address[]", "uint256[]", "bytes[]", "bytes32"], [actions.targets, actions.values, actions.calldatas, descriptionHash]))).toString();
  return { descriptionHash, proposalId };
}
export function evidenceDigest(threadId: string, messageId: number, authorId: string, content: string) {
  return id(JSON.stringify({ version: 1, threadId, messageId, authorId, content }));
}
