// SPDX-License-Identifier: ISC
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice One immutable bounty per board task; only the governance timelock can fund it.
/// Review is an explicit trust boundary: the named reviewer attests to off-chain quality.
contract AAMBTaskEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum Status { Missing, Funded, Claimed, Submitted, Paid, Refunded }
    struct Task {
        uint256 reward;
        address reviewer;
        address worker;
        uint64 deadline;
        uint64 claimExpiresAt;
        bytes32 specificationHash;
        bytes32 evidenceHash;
        Status status;
    }
    IERC20 public immutable token;
    address public immutable treasury;
    uint64 public constant MAX_LEASE = 7 days;
    uint64 public constant REVIEW_GRACE = 7 days;
    mapping(bytes32 => Task) public tasks;

    error Unauthorized();
    error InvalidTask();
    error InvalidState();
    error InvalidEvidence();
    event TaskFunded(bytes32 indexed taskId, uint256 reward, address indexed reviewer, uint64 deadline, bytes32 specificationHash);
    event TaskClaimed(bytes32 indexed taskId, address indexed worker, uint64 claimExpiresAt);
    event WorkSubmitted(bytes32 indexed taskId, address indexed worker, bytes32 evidenceHash);
    event WorkRejected(bytes32 indexed taskId, bytes32 evidenceHash);
    event RewardPaid(bytes32 indexed taskId, address indexed worker, uint256 reward, bytes32 evidenceHash);
    event TaskRefunded(bytes32 indexed taskId, uint256 reward);

    constructor(IERC20 rewardToken, address governanceTreasury) {
        if (address(rewardToken) == address(0) || governanceTreasury == address(0)) revert InvalidTask();
        token = rewardToken;
        treasury = governanceTreasury;
    }

    function fundTask(bytes32 id, uint256 reward, address reviewer, uint64 deadline, bytes32 specificationHash) external nonReentrant {
        if (msg.sender != treasury) revert Unauthorized();
        if (id == bytes32(0) || reward == 0 || reviewer == address(0) || reviewer == address(this)
            || deadline <= block.timestamp || specificationHash == bytes32(0)) revert InvalidTask();
        if (tasks[id].status != Status.Missing) revert InvalidState();
        tasks[id] = Task(reward, reviewer, address(0), deadline, 0, specificationHash, bytes32(0), Status.Funded);
        token.safeTransferFrom(treasury, address(this), reward);
        emit TaskFunded(id, reward, reviewer, deadline, specificationHash);
    }

    function claimTask(bytes32 id, uint64 leaseSeconds) external {
        Task storage t = tasks[id];
        if (msg.sender == t.reviewer) revert Unauthorized();
        if (t.status != Status.Funded && !(t.status == Status.Claimed && block.timestamp >= t.claimExpiresAt)) revert InvalidState();
        if (leaseSeconds == 0 || leaseSeconds > MAX_LEASE || block.timestamp + leaseSeconds > t.deadline) revert InvalidTask();
        t.worker = msg.sender;
        t.claimExpiresAt = uint64(block.timestamp) + leaseSeconds;
        t.status = Status.Claimed;
        emit TaskClaimed(id, msg.sender, t.claimExpiresAt);
    }

    function releaseTask(bytes32 id) external {
        Task storage t = tasks[id];
        if (msg.sender != t.worker) revert Unauthorized();
        if (t.status != Status.Claimed) revert InvalidState();
        t.worker = address(0);
        t.claimExpiresAt = 0;
        t.status = Status.Funded;
    }

    function submitWork(bytes32 id, bytes32 evidenceHash) external {
        Task storage t = tasks[id];
        if (msg.sender != t.worker) revert Unauthorized();
        if (t.status != Status.Claimed || block.timestamp >= t.claimExpiresAt || block.timestamp > t.deadline) revert InvalidState();
        if (evidenceHash == bytes32(0)) revert InvalidEvidence();
        t.evidenceHash = evidenceHash;
        t.status = Status.Submitted;
        emit WorkSubmitted(id, msg.sender, evidenceHash);
    }

    function approveWork(bytes32 id, bytes32 expectedEvidenceHash) external nonReentrant {
        Task storage t = tasks[id];
        if (msg.sender != t.reviewer || msg.sender == t.worker) revert Unauthorized();
        if (t.status != Status.Submitted || block.timestamp > uint256(t.deadline) + REVIEW_GRACE) revert InvalidState();
        if (t.evidenceHash != expectedEvidenceHash) revert InvalidEvidence();
        t.status = Status.Paid;
        token.safeTransfer(t.worker, t.reward);
        emit RewardPaid(id, t.worker, t.reward, t.evidenceHash);
    }

    function rejectWork(bytes32 id, bytes32 expectedEvidenceHash) external {
        Task storage t = tasks[id];
        if (msg.sender != t.reviewer) revert Unauthorized();
        if (t.status != Status.Submitted) revert InvalidState();
        if (t.evidenceHash != expectedEvidenceHash) revert InvalidEvidence();
        emit WorkRejected(id, t.evidenceHash);
        t.evidenceHash = bytes32(0);
        t.worker = address(0);
        t.claimExpiresAt = 0;
        t.status = Status.Funded;
    }

    function refundExpired(bytes32 id) external nonReentrant {
        Task storage t = tasks[id];
        if (t.status != Status.Funded && t.status != Status.Claimed && t.status != Status.Submitted) revert InvalidState();
        uint256 expires = uint256(t.deadline) + (t.status == Status.Submitted ? REVIEW_GRACE : 0);
        if (block.timestamp <= expires) revert InvalidState();
        t.status = Status.Refunded;
        token.safeTransfer(treasury, t.reward);
        emit TaskRefunded(id, t.reward);
    }
}
