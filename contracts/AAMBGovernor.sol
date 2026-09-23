// SPDX-License-Identifier: ISC
pragma solidity ^0.8.24;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

contract AAMBGovernor is Governor, GovernorSettings, GovernorCountingSimple,
    GovernorVotes, GovernorVotesQuorumFraction, GovernorTimelockControl {
    constructor(IVotes token, TimelockController treasury, uint48 delaySeconds, uint32 periodSeconds)
        Governor("AAMB DAO") GovernorSettings(delaySeconds, periodSeconds, 100 ether)
        GovernorVotes(token) GovernorVotesQuorumFraction(10) GovernorTimelockControl(treasury) {}

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) { return super.votingDelay(); }
    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) { return super.votingPeriod(); }
    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) { return super.proposalThreshold(); }
    function state(uint256 id) public view override(Governor, GovernorTimelockControl) returns (ProposalState) { return super.state(id); }
    function proposalNeedsQueuing(uint256 id) public view override(Governor, GovernorTimelockControl) returns (bool) { return super.proposalNeedsQueuing(id); }
    function _queueOperations(uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory calls, bytes32 descriptionHash)
        internal override(Governor, GovernorTimelockControl) returns (uint48)
    { return super._queueOperations(id, targets, values, calls, descriptionHash); }
    function _executeOperations(uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory calls, bytes32 descriptionHash)
        internal override(Governor, GovernorTimelockControl)
    { super._executeOperations(id, targets, values, calls, descriptionHash); }
    function _cancel(address[] memory targets, uint256[] memory values, bytes[] memory calls, bytes32 descriptionHash)
        internal override(Governor, GovernorTimelockControl) returns (uint256)
    { return super._cancel(targets, values, calls, descriptionHash); }
    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) { return super._executor(); }
}
