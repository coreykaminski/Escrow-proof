// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC8183} from "../IERC8183.sol";

interface IERC20Minimal {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title A plain ERC-8183 job contract, test only.
/// @notice No Proof Desk extensions (no createAndFund, no settle, no fee): stands in for someone
/// else's deployment, to prove the evaluator adapter works with any standard implementation.
/// Hooks aren't supported (must be address(0)).
contract ReferenceERC8183 is IERC8183 {
    IERC20Minimal public immutable paymentToken;
    uint256 public jobCount;
    mapping(uint256 => Job) internal jobs;

    error Unauthorized();
    error InvalidState();
    error InvalidParams();
    error Expired();
    error NotExpired();
    error TransferFailed();

    constructor(address token) {
        paymentToken = IERC20Minimal(token);
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        if (evaluator == address(0) || expiredAt <= block.timestamp || hook != address(0)) {
            revert InvalidParams();
        }
        jobId = ++jobCount;
        jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: JobStatus.Open,
            hook: address(0)
        });
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, address(0));
    }

    function setProvider(uint256 jobId, address provider_) external {
        Job storage j = _job(jobId);
        if (msg.sender != j.client) revert Unauthorized();
        if (j.status != JobStatus.Open || j.provider != address(0) || provider_ == address(0)) {
            revert InvalidState();
        }
        j.provider = provider_;
        emit ProviderSet(jobId, provider_);
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        Job storage j = _job(jobId);
        if (msg.sender != j.client && msg.sender != j.provider) revert Unauthorized();
        if (j.status != JobStatus.Open) revert InvalidState();
        j.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    function fund(uint256 jobId, bytes calldata) external {
        Job storage j = _job(jobId);
        if (msg.sender != j.client) revert Unauthorized();
        if (j.status != JobStatus.Open || j.provider == address(0) || j.budget == 0) {
            revert InvalidState();
        }
        if (block.timestamp >= j.expiredAt) revert Expired();
        j.status = JobStatus.Funded;
        if (!paymentToken.transferFrom(msg.sender, address(this), j.budget)) revert TransferFailed();
        emit JobFunded(jobId, msg.sender, j.budget);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        Job storage j = _job(jobId);
        if (msg.sender != j.provider) revert Unauthorized();
        if (j.status != JobStatus.Funded) revert InvalidState();
        if (block.timestamp >= j.expiredAt) revert Expired();
        j.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata) external {
        Job storage j = _job(jobId);
        if (msg.sender != j.evaluator) revert Unauthorized();
        if (j.status != JobStatus.Submitted) revert InvalidState();
        if (block.timestamp >= j.expiredAt) revert Expired();
        j.status = JobStatus.Completed;
        emit JobCompleted(jobId, msg.sender, reason);
        _send(j.provider, j.budget);
        emit PaymentReleased(jobId, j.provider, j.budget);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata) external {
        Job storage j = _job(jobId);
        if (j.status == JobStatus.Open) {
            if (msg.sender != j.client) revert Unauthorized();
            j.status = JobStatus.Rejected;
            emit JobRejected(jobId, msg.sender, reason);
            return;
        }
        if (msg.sender != j.evaluator) revert Unauthorized();
        if (j.status != JobStatus.Funded && j.status != JobStatus.Submitted) revert InvalidState();
        j.status = JobStatus.Rejected;
        emit JobRejected(jobId, msg.sender, reason);
        _send(j.client, j.budget);
        emit Refunded(jobId, j.client, j.budget);
    }

    function claimRefund(uint256 jobId) external {
        Job storage j = _job(jobId);
        if (j.status != JobStatus.Funded && j.status != JobStatus.Submitted) revert InvalidState();
        if (block.timestamp < j.expiredAt) revert NotExpired();
        j.status = JobStatus.Expired;
        emit JobExpired(jobId);
        _send(j.client, j.budget);
        emit Refunded(jobId, j.client, j.budget);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _job(jobId);
    }

    function _job(uint256 jobId) internal view returns (Job storage j) {
        j = jobs[jobId];
        if (j.id == 0) revert InvalidParams();
    }

    function _send(address to, uint256 amount) internal {
        if (!paymentToken.transfer(to, amount)) revert TransferFailed();
    }
}
