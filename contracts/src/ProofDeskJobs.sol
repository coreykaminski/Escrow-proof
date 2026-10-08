// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC8183} from "./IERC8183.sol";

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// EIP-3009 (USDC). `receiveWithAuthorization` requires msg.sender == to, so a relayed signature
/// can only ever move funds into this contract; nobody can front-run it elsewhere.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title Proof Desk job escrow (ERC-8183 compatible, single stablecoin)
/// @notice Non-custodial: funds sit in this contract, never with Proof Desk. Proof Desk is only
/// the evaluator address, so the most it can do is choose between the job's provider and client
/// (and not after expiry, when the client can always take a full refund).
///
/// Extensions to ERC-8183, all optional for other integrators:
/// - `createAndFund` / `createAndFundWithAuthorization`: the client posts the agreed price and
///   funds in one step (the price was agreed off-chain in the signed spec), the second one
///   gasless via an EIP-3009 signature (the x402 funding path).
/// - `settle(jobId, releaseBP, reason)`: the evaluator's general decision — release all
///   (10000), refund all (0) or split — from Funded or Submitted. Delivery is recorded
///   off-chain in Proof Desk's ledger, so providers never need to send a transaction.
/// Hooks are not supported (hook must be zero), which keeps `claimRefund` unblockable.
contract ProofDeskJobs is IERC8183 {
    uint16 public constant MAX_FEE_BP = 500; // 5%
    uint16 public constant BP = 10_000;
    uint256 public constant MIN_EXPIRY_LEAD = 5 minutes;

    IERC20 public immutable paymentToken;
    address public owner;
    address public treasury;
    /// Fee on released funds, in basis points. Each job keeps the rate in force when it was created.
    uint16 public platformFeeBP;

    uint256 public jobCount;
    /// Sum of budgets of Funded and Submitted jobs. Always equals what this contract owes.
    uint256 public totalEscrowed;

    mapping(uint256 => Job) internal _jobs;
    mapping(uint256 => uint16) public jobFeeBP;

    uint256 private _lock = 1;

    event JobSettled(
        uint256 indexed jobId, address indexed evaluator, uint16 releaseBP, bytes32 reason
    );
    event FeePaid(uint256 indexed jobId, address indexed treasury, uint256 amount);
    event FeeChanged(uint16 feeBP);
    event TreasuryChanged(address treasury);
    event OwnerChanged(address owner);

    error Unauthorized();
    error InvalidState();
    error InvalidParams();
    error Expired();
    error NotExpired();
    error BudgetMismatch();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IERC20 token, address treasury_, uint16 feeBP, address owner_) {
        if (address(token) == address(0) || treasury_ == address(0) || owner_ == address(0)) {
            revert InvalidParams();
        }
        if (feeBP > MAX_FEE_BP) revert InvalidParams();
        paymentToken = token;
        treasury = treasury_;
        platformFeeBP = feeBP;
        owner = owner_;
    }

    // -----------------------------------------------------------------------------------------
    // ERC-8183 core
    // -----------------------------------------------------------------------------------------

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256) {
        return _create(msg.sender, provider, evaluator, expiredAt, description, hook);
    }

    function setProvider(uint256 jobId, address provider_) external {
        Job storage j = _job(jobId);
        if (msg.sender != j.client) revert Unauthorized();
        if (j.status != JobStatus.Open || j.provider != address(0)) revert InvalidState();
        if (provider_ == address(0) || provider_ == j.client) revert InvalidParams();
        j.provider = provider_;
        emit ProviderSet(jobId, provider_);
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        Job storage j = _job(jobId);
        if (msg.sender != j.provider) revert Unauthorized();
        if (j.status != JobStatus.Open) revert InvalidState();
        j.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    /// @param optParams abi.encode(uint256 expectedBudget), or empty. Pass it: it stops a provider
    /// from raising the budget between the client signing and the transaction landing.
    function fund(uint256 jobId, bytes calldata optParams) external nonReentrant {
        Job storage j = _job(jobId);
        if (msg.sender != j.client) revert Unauthorized();
        if (optParams.length == 32 && abi.decode(optParams, (uint256)) != j.budget) {
            revert BudgetMismatch();
        } else if (optParams.length != 0 && optParams.length != 32) {
            revert InvalidParams();
        }
        _markFunded(j);
        _pull(j.client, j.budget);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        Job storage j = _job(jobId);
        if (msg.sender != j.provider) revert Unauthorized();
        if (j.status != JobStatus.Funded) revert InvalidState();
        if (block.timestamp >= j.expiredAt) revert Expired();
        j.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata) external nonReentrant {
        Job storage j = _job(jobId);
        if (msg.sender != j.evaluator) revert Unauthorized();
        if (j.status != JobStatus.Submitted) revert InvalidState();
        if (block.timestamp >= j.expiredAt) revert Expired();
        j.status = JobStatus.Completed;
        emit JobCompleted(jobId, msg.sender, reason);
        _payOut(j, BP);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata) external nonReentrant {
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
        _payOut(j, 0);
    }

    /// Anyone may call once the job has expired unfinished; the full budget goes back to the
    /// client. Calls no hooks and needs nobody's permission, so it can't be blocked.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        if (j.status != JobStatus.Funded && j.status != JobStatus.Submitted) revert InvalidState();
        if (block.timestamp < j.expiredAt) revert NotExpired();
        j.status = JobStatus.Expired;
        emit JobExpired(jobId);
        _payOut(j, 0);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _job(jobId);
    }

    // -----------------------------------------------------------------------------------------
    // Extensions
    // -----------------------------------------------------------------------------------------

    /// Create a job at the agreed price and fund it in one transaction (client = msg.sender).
    function createAndFund(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        uint256 budget
    ) external nonReentrant returns (uint256 jobId) {
        if (provider == address(0)) revert InvalidParams();
        jobId = _create(msg.sender, provider, evaluator, expiredAt, description, address(0));
        Job storage j = _jobs[jobId];
        j.budget = budget;
        emit BudgetSet(jobId, budget);
        _markFunded(j);
        _pull(msg.sender, budget);
    }

    /// Gasless funding: the client signs an EIP-3009 ReceiveWithAuthorization for `budget` to
    /// this contract, and anyone (Proof Desk's relayer) submits it. The nonce must be
    /// `authorizationNonce(client, provider, evaluator, expiredAt, description, budget)`, so the
    /// signature funds exactly this job and can't be reused for any other.
    function createAndFundWithAuthorization(
        address client,
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        uint256 budget,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 jobId) {
        if (provider == address(0) || client == address(0)) revert InvalidParams();
        bytes32 nonce = authorizationNonce(client, provider, evaluator, expiredAt, description, budget);
        jobId = _create(client, provider, evaluator, expiredAt, description, address(0));
        Job storage j = _jobs[jobId];
        j.budget = budget;
        emit BudgetSet(jobId, budget);
        _markFunded(j);
        uint256 before = paymentToken.balanceOf(address(this));
        IERC3009(address(paymentToken)).receiveWithAuthorization(
            client, address(this), budget, validAfter, validBefore, nonce, v, r, s
        );
        if (paymentToken.balanceOf(address(this)) - before != budget) revert TransferFailed();
    }

    /// The EIP-3009 nonce binding an authorization to one job's exact terms on this contract.
    function authorizationNonce(
        address client,
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        uint256 budget
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                block.chainid,
                address(this),
                client,
                provider,
                evaluator,
                expiredAt,
                keccak256(bytes(description)),
                budget
            )
        );
    }

    /// The evaluator's decision on a funded job: `releaseBP` of the budget goes to the provider
    /// (less the job's fee on that part), the rest back to the client. 10000 = release, 0 = refund.
    /// `reason` is the hash of the decision record in Proof Desk's ledger.
    function settle(uint256 jobId, uint16 releaseBP, bytes32 reason) external nonReentrant {
        Job storage j = _job(jobId);
        if (msg.sender != j.evaluator) revert Unauthorized();
        if (j.status != JobStatus.Funded && j.status != JobStatus.Submitted) revert InvalidState();
        if (releaseBP > BP) revert InvalidParams();
        // Paying the provider is only possible before expiry; after it the client's refund
        // right takes over. A refund decision is fine at any time.
        if (releaseBP > 0 && block.timestamp >= j.expiredAt) revert Expired();
        if (releaseBP == 0) {
            j.status = JobStatus.Rejected;
            emit JobRejected(jobId, msg.sender, reason);
        } else {
            j.status = JobStatus.Completed;
            emit JobCompleted(jobId, msg.sender, reason);
        }
        emit JobSettled(jobId, msg.sender, releaseBP, reason);
        _payOut(j, releaseBP);
    }

    // -----------------------------------------------------------------------------------------
    // Admin (cannot touch escrowed funds)
    // -----------------------------------------------------------------------------------------

    function setFee(uint16 feeBP) external {
        if (msg.sender != owner) revert Unauthorized();
        if (feeBP > MAX_FEE_BP) revert InvalidParams();
        platformFeeBP = feeBP;
        emit FeeChanged(feeBP);
    }

    function setTreasury(address treasury_) external {
        if (msg.sender != owner) revert Unauthorized();
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    function transferOwnership(address owner_) external {
        if (msg.sender != owner) revert Unauthorized();
        if (owner_ == address(0)) revert InvalidParams();
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    // -----------------------------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------------------------

    function _job(uint256 jobId) internal view returns (Job storage j) {
        j = _jobs[jobId];
        if (j.client == address(0)) revert InvalidParams();
    }

    function _create(
        address client,
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) internal returns (uint256 jobId) {
        if (hook != address(0)) revert InvalidParams();
        if (evaluator == address(0) || evaluator == client || evaluator == provider) {
            revert InvalidParams();
        }
        if (provider == client) revert InvalidParams();
        if (expiredAt <= block.timestamp + MIN_EXPIRY_LEAD) revert InvalidParams();
        jobId = ++jobCount;
        _jobs[jobId] = Job({
            id: jobId,
            client: client,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: JobStatus.Open,
            hook: address(0)
        });
        jobFeeBP[jobId] = platformFeeBP;
        emit JobCreated(jobId, client, provider, evaluator, expiredAt, address(0));
    }

    function _markFunded(Job storage j) internal {
        if (j.status != JobStatus.Open) revert InvalidState();
        if (j.provider == address(0) || j.budget == 0) revert InvalidState();
        if (block.timestamp >= j.expiredAt) revert Expired();
        j.status = JobStatus.Funded;
        totalEscrowed += j.budget;
        emit JobFunded(j.id, j.client, j.budget);
    }

    function _pull(address from, uint256 amount) internal {
        uint256 before = paymentToken.balanceOf(address(this));
        _call(abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        // Fee-on-transfer or rebasing tokens would break the accounting; refuse them.
        if (paymentToken.balanceOf(address(this)) - before != amount) revert TransferFailed();
    }

    /// Releases `releaseBP` of the budget to the provider (minus the fee on that part) and the
    /// rest to the client. Status must already be terminal (checks-effects-interactions).
    function _payOut(Job storage j, uint16 releaseBP) internal {
        uint256 budget = j.budget;
        totalEscrowed -= budget;
        uint256 released = budget * releaseBP / BP;
        uint256 fee = released * jobFeeBP[j.id] / BP;
        uint256 toProvider = released - fee;
        uint256 toClient = budget - released;
        if (fee > 0) {
            _send(treasury, fee);
            emit FeePaid(j.id, treasury, fee);
        }
        if (toProvider > 0) {
            _send(j.provider, toProvider);
            emit PaymentReleased(j.id, j.provider, toProvider);
        }
        if (toClient > 0) {
            _send(j.client, toClient);
            emit Refunded(j.id, j.client, toClient);
        }
    }

    function _send(address to, uint256 amount) internal {
        _call(abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    /// ERC-20 call that tolerates tokens returning nothing, and fails on false or revert.
    function _call(bytes memory data) internal {
        (bool ok, bytes memory ret) = address(paymentToken).call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        if (ret.length == 0 && address(paymentToken).code.length == 0) revert TransferFailed();
    }
}
