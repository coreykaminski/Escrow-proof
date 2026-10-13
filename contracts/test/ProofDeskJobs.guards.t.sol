// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LedgerAnchor} from "../src/LedgerAnchor.sol";
import {IERC20, ProofDeskJobs} from "../src/ProofDeskJobs.sol";
import {MockUSDC} from "../src/test/MockUSDC.sol";

/// Tokens that misbehave in the ways an auditor (or an attacker) would try.
contract BadToken {
    enum Mode {
        Normal,
        TakesFee, // fee-on-transfer: delivers less than asked
        ReturnsFalse, // signals failure by returning false
        ReturnsNothing, // USDT-style: no return value (must still work)
        Reenters // calls back into the job contract during transfer
    }

    Mode public mode;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    ProofDeskJobs public target;
    uint256 public targetJob;
    bytes public reentryError;

    function setMode(Mode m) external {
        mode = m;
    }

    function setTarget(ProofDeskJobs t, uint256 jobId) external {
        target = t;
        targetJob = jobId;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += mode == Mode.TakesFee ? amount - amount / 100 : amount;
    }

    function transfer(address to, uint256 amount) external {
        if (mode == Mode.Reenters && address(target) != address(0)) {
            // Try to settle again while the outer settlement is still running.
            try target.claimRefund(targetJob) {} catch (bytes memory err) {
                reentryError = err;
            }
        }
        _move(msg.sender, to, amount);
        _return(true);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        _return(true);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32,
        uint8,
        bytes32,
        bytes32
    ) external {
        _move(from, to, value);
    }

    /// Returns `ok`, `false`, or nothing at all, per the mode, with raw assembly.
    function _return(bool ok) internal view {
        if (mode == Mode.ReturnsNothing) {
            assembly {
                return(0, 0)
            }
        }
        bool v = mode == Mode.ReturnsFalse ? false : ok;
        assembly {
            mstore(0, v)
            return(0, 32)
        }
    }
}

contract ProofDeskJobsGuardsTest is Test {
    MockUSDC usdc;
    ProofDeskJobs jobs;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address evaluator = makeAddr("evaluator");
    address provider = makeAddr("provider");
    address client = makeAddr("client");
    address stranger = makeAddr("stranger");
    uint256 constant BUDGET = 100e6;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        jobs = new ProofDeskJobs(IERC20(address(usdc)), treasury, 200, owner);
        usdc.mint(client, 1_000e6);
        vm.prank(client);
        usdc.approve(address(jobs), type(uint256).max);
    }

    function _open() internal returns (uint256 id) {
        vm.prank(client);
        id = jobs.createJob(address(0), evaluator, block.timestamp + 7 days, "d", address(0));
    }

    // --- constructor ---

    function test_constructor_rejectsZeroAddressesAndExcessiveFee() public {
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        new ProofDeskJobs(IERC20(address(0)), treasury, 200, owner);
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        new ProofDeskJobs(IERC20(address(usdc)), address(0), 200, owner);
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        new ProofDeskJobs(IERC20(address(usdc)), treasury, 200, address(0));
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        new ProofDeskJobs(IERC20(address(usdc)), treasury, 501, owner);
    }

    // --- setProvider / setBudget / fund guards ---

    function test_setProvider_guards() public {
        uint256 id = _open();
        vm.prank(stranger);
        vm.expectRevert(ProofDeskJobs.Unauthorized.selector);
        jobs.setProvider(id, provider);
        vm.startPrank(client);
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        jobs.setProvider(id, address(0));
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        jobs.setProvider(id, client);
        jobs.setProvider(id, provider);
        vm.expectRevert(ProofDeskJobs.InvalidState.selector);
        jobs.setProvider(id, stranger); // already set
        vm.stopPrank();
    }

    function test_setBudget_onlyProviderWhileOpen() public {
        uint256 id = _open();
        vm.prank(client);
        jobs.setProvider(id, provider);
        vm.prank(client);
        vm.expectRevert(ProofDeskJobs.Unauthorized.selector);
        jobs.setBudget(id, BUDGET, "");
        vm.prank(provider);
        jobs.setBudget(id, BUDGET, "");
        vm.prank(client);
        jobs.fund(id, "");
        vm.prank(provider);
        vm.expectRevert(ProofDeskJobs.InvalidState.selector);
        jobs.setBudget(id, BUDGET * 2, "");
    }

    function test_fund_guards() public {
        uint256 id = _open();
        vm.prank(client);
        jobs.setProvider(id, provider);
        vm.prank(provider);
        jobs.setBudget(id, BUDGET, "");
        vm.prank(stranger);
        vm.expectRevert(ProofDeskJobs.Unauthorized.selector);
        jobs.fund(id, "");
        vm.startPrank(client);
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        jobs.fund(id, hex"01"); // optParams must be empty or one uint256
        jobs.fund(id, abi.encode(BUDGET));
        vm.expectRevert(ProofDeskJobs.InvalidState.selector);
        jobs.fund(id, ""); // twice
        vm.stopPrank();
    }

    function test_fund_afterExpiry_reverts() public {
        vm.prank(client);
        uint256 id = jobs.createJob(provider, evaluator, block.timestamp + 2 hours, "d", address(0));
        vm.prank(provider);
        jobs.setBudget(id, BUDGET, "");
        vm.warp(block.timestamp + 3 hours);
        vm.prank(client);
        vm.expectRevert(ProofDeskJobs.Expired.selector);
        jobs.fund(id, "");
    }

    function test_createAndFund_requiresParties() public {
        vm.prank(client);
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        jobs.createAndFund(address(0), evaluator, block.timestamp + 7 days, "d", BUDGET);
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        jobs.createAndFundWithAuthorization(
            address(0), provider, evaluator, block.timestamp + 7 days, "d", BUDGET, 0, type(uint256).max, 27, 0, 0
        );
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        jobs.createAndFundWithAuthorization(
            client, address(0), evaluator, block.timestamp + 7 days, "d", BUDGET, 0, type(uint256).max, 27, 0, 0
        );
    }

    function test_unknownJob_reverts() public {
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        jobs.getJob(999);
    }

    // --- misbehaving tokens ---

    function _withToken(BadToken.Mode mode) internal returns (BadToken t, ProofDeskJobs j) {
        t = new BadToken();
        t.setMode(mode);
        j = new ProofDeskJobs(IERC20(address(t)), treasury, 200, owner);
        t.mint(client, 1_000e6);
        vm.prank(client);
        t.approve(address(j), type(uint256).max);
    }

    function test_feeOnTransferTokens_areRefused() public {
        (, ProofDeskJobs j) = _withToken(BadToken.Mode.TakesFee);
        vm.prank(client);
        vm.expectRevert(ProofDeskJobs.TransferFailed.selector);
        j.createAndFund(provider, evaluator, block.timestamp + 7 days, "d", BUDGET);
        vm.expectRevert(ProofDeskJobs.TransferFailed.selector);
        j.createAndFundWithAuthorization(
            client, provider, evaluator, block.timestamp + 7 days, "d", BUDGET, 0, type(uint256).max, 27, 0, 0
        );
    }

    function test_tokensReturningFalse_failTheTransfer() public {
        (, ProofDeskJobs j) = _withToken(BadToken.Mode.ReturnsFalse);
        vm.prank(client);
        vm.expectRevert(ProofDeskJobs.TransferFailed.selector);
        j.createAndFund(provider, evaluator, block.timestamp + 7 days, "d", BUDGET);
    }

    function test_tokensReturningNothing_work() public {
        (BadToken t, ProofDeskJobs j) = _withToken(BadToken.Mode.ReturnsNothing);
        vm.prank(client);
        uint256 id = j.createAndFund(provider, evaluator, block.timestamp + 7 days, "d", BUDGET);
        vm.prank(evaluator);
        j.settle(id, 10_000, bytes32("ok"));
        assertEq(t.balanceOf(provider), BUDGET - BUDGET * 200 / 10_000);
    }

    function test_reentrancyDuringPayout_isBlocked() public {
        (BadToken t, ProofDeskJobs j) = _withToken(BadToken.Mode.Normal);
        vm.prank(client);
        uint256 id = j.createAndFund(provider, evaluator, block.timestamp + 7 days, "d", BUDGET);
        t.setTarget(j, id);
        t.setMode(BadToken.Mode.Reenters);
        vm.prank(evaluator);
        j.settle(id, 0, bytes32("refund"));
        // The nested call was refused by the reentrancy guard, and the refund still went through once.
        assertEq(bytes4(t.reentryError()), ProofDeskJobs.Reentrancy.selector);
        assertEq(t.balanceOf(client), 1_000e6);
        assertEq(t.balanceOf(address(j)), 0);
    }

    // --- LedgerAnchor ---

    function test_ledgerAnchor_rejectsZeroAddresses() public {
        vm.expectRevert(LedgerAnchor.InvalidParams.selector);
        new LedgerAnchor(address(0), evaluator);
        vm.expectRevert(LedgerAnchor.InvalidParams.selector);
        new LedgerAnchor(owner, address(0));
        LedgerAnchor a = new LedgerAnchor(owner, evaluator);
        vm.prank(owner);
        vm.expectRevert(LedgerAnchor.InvalidParams.selector);
        a.setAnchorer(address(0));
    }
}
