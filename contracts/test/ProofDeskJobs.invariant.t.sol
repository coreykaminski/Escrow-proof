// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC8183} from "../src/IERC8183.sol";
import {IERC20, ProofDeskJobs} from "../src/ProofDeskJobs.sol";
import {MockUSDC} from "../src/test/MockUSDC.sol";

/// Drives the contract with random actions from every party (clients, provider, evaluator, an
/// attacker), including unauthorized ones, and keeps ghost records to check against.
contract Handler is Test {
    ProofDeskJobs public jobs;
    MockUSDC public usdc;
    address public evaluator;
    address public provider;
    address public attacker;
    address[3] public clients;
    address[] public everyone;

    uint256[] public ids;
    /// Decisions (complete/reject-after-funding/settle) that succeeded from a non-evaluator.
    uint256 public ghostUnauthorizedDecisions;
    /// Jobs that paid the provider anything after they had expired.
    uint256 public ghostPaidAfterExpiry;
    uint256 public ghostMinted;

    constructor(ProofDeskJobs jobs_, MockUSDC usdc_, address evaluator_, address provider_) {
        jobs = jobs_;
        usdc = usdc_;
        evaluator = evaluator_;
        provider = provider_;
        attacker = makeAddr("attacker");
        for (uint256 i = 0; i < 3; i++) {
            clients[i] = makeAddr(string.concat("client", vm.toString(i)));
            everyone.push(clients[i]);
        }
        everyone.push(provider);
        everyone.push(evaluator);
        everyone.push(attacker);
        everyone.push(jobs.treasury());
        for (uint256 i = 0; i < everyone.length; i++) {
            vm.prank(everyone[i]);
            usdc.approve(address(jobs), type(uint256).max);
        }
    }

    function everyoneLength() external view returns (uint256) {
        return everyone.length;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function _client(uint256 seed) internal view returns (address) {
        return clients[seed % 3];
    }

    function _anyActor(uint256 seed) internal view returns (address) {
        return everyone[seed % everyone.length];
    }

    function _pickJob(uint256 seed) internal view returns (uint256) {
        if (ids.length == 0) return 0;
        return ids[seed % ids.length];
    }

    function createAndFund(uint256 seed, uint96 budget, uint32 lifetime) external {
        address c = _client(seed);
        budget = uint96(bound(budget, 1, 50_000e6));
        uint256 exp = block.timestamp + bound(lifetime, 6 minutes, 60 days);
        usdc.mint(c, budget);
        ghostMinted += budget;
        vm.prank(c);
        ids.push(jobs.createAndFund(provider, evaluator, exp, "job", budget));
    }

    function createStandard(uint256 seed, uint96 budget, uint32 lifetime) external {
        address c = _client(seed);
        budget = uint96(bound(budget, 1, 50_000e6));
        uint256 exp = block.timestamp + bound(lifetime, 6 minutes, 60 days);
        vm.prank(c);
        uint256 id = jobs.createJob(provider, evaluator, exp, "job", address(0));
        ids.push(id);
        vm.prank(provider);
        jobs.setBudget(id, budget, "");
        if (seed % 2 == 0) {
            usdc.mint(c, budget);
            ghostMinted += budget;
            vm.prank(c);
            jobs.fund(id, abi.encode(uint256(budget)));
        }
    }

    function submit(uint256 seed) external {
        uint256 id = _pickJob(seed);
        if (id == 0) return;
        vm.prank(seed % 4 == 0 ? attacker : provider);
        try jobs.submit(id, keccak256(abi.encode(seed)), "") {} catch {}
    }

    function _decide(uint256 seed, address caller, uint256 kind, uint16 bp) internal {
        uint256 id = _pickJob(seed);
        if (id == 0) return;
        IERC8183.Job memory before = jobs.getJob(id);
        uint256 providerBefore = usdc.balanceOf(provider);
        bool ok;
        vm.prank(caller);
        if (kind == 0) {
            try jobs.complete(id, "", "") {
                ok = true;
            } catch {}
        } else if (kind == 1) {
            try jobs.reject(id, "", "") {
                ok = true;
            } catch {}
        } else {
            try jobs.settle(id, uint16(bound(bp, 0, 10_000)), "") {
                ok = true;
            } catch {}
        }
        bool wasFunded =
            before.status == IERC8183.JobStatus.Funded || before.status == IERC8183.JobStatus.Submitted;
        if (ok && wasFunded && caller != before.evaluator) ghostUnauthorizedDecisions++;
        if (usdc.balanceOf(provider) > providerBefore && block.timestamp >= before.expiredAt) {
            ghostPaidAfterExpiry++;
        }
    }

    function decideAsEvaluator(uint256 seed, uint256 kind, uint16 bp) external {
        _decide(seed, evaluator, kind % 3, bp);
    }

    function decideAsAnyone(uint256 seed, uint256 actorSeed, uint256 kind, uint16 bp) external {
        _decide(seed, _anyActor(actorSeed), kind % 3, bp);
    }

    function claimRefund(uint256 seed, uint256 actorSeed) external {
        uint256 id = _pickJob(seed);
        if (id == 0) return;
        vm.prank(_anyActor(actorSeed));
        try jobs.claimRefund(id) {} catch {}
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 10 days));
    }

    function changeFee(uint16 bp) external {
        vm.prank(jobs.owner());
        jobs.setFee(uint16(bound(bp, 0, 500)));
    }
}

contract ProofDeskJobsInvariantTest is Test {
    ProofDeskJobs jobs;
    MockUSDC usdc;
    Handler handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        jobs = new ProofDeskJobs(IERC20(address(usdc)), makeAddr("treasury"), 200, makeAddr("owner"));
        handler = new Handler(jobs, usdc, makeAddr("evaluator"), makeAddr("provider"));
        targetContract(address(handler));
    }

    /// Every token in the contract belongs to exactly one live job, and nothing was lost or created.
    function invariant_fundsConserved() public view {
        uint256 live;
        for (uint256 i = 0; i < handler.idsLength(); i++) {
            IERC8183.Job memory j = jobs.getJob(handler.ids(i));
            if (j.status == IERC8183.JobStatus.Funded || j.status == IERC8183.JobStatus.Submitted) {
                live += j.budget;
            }
        }
        assertEq(jobs.totalEscrowed(), live, "escrow total matches live budgets");
        assertEq(usdc.balanceOf(address(jobs)), live, "contract holds exactly the live budgets");

        uint256 held = usdc.balanceOf(address(jobs));
        for (uint256 i = 0; i < handler.everyoneLength(); i++) {
            held += usdc.balanceOf(handler.everyone(i));
        }
        assertEq(held, handler.ghostMinted(), "no funds created or destroyed");
    }

    /// Only the evaluator ever decided a funded job.
    function invariant_onlyEvaluatorDecides() public view {
        assertEq(handler.ghostUnauthorizedDecisions(), 0);
    }

    /// The provider never got paid from a job that had already expired.
    function invariant_noPaymentAfterExpiry() public view {
        assertEq(handler.ghostPaidAfterExpiry(), 0);
    }

    /// Any funded job that has expired can be refunded in full right now, by anyone.
    function invariant_expiredJobsAlwaysRefundable() public {
        for (uint256 i = 0; i < handler.idsLength(); i++) {
            IERC8183.Job memory j = jobs.getJob(handler.ids(i));
            bool live =
                j.status == IERC8183.JobStatus.Funded || j.status == IERC8183.JobStatus.Submitted;
            if (!live || block.timestamp < j.expiredAt) continue;
            uint256 snap = vm.snapshotState();
            uint256 before = usdc.balanceOf(j.client);
            vm.prank(address(0xDEAD));
            jobs.claimRefund(j.id);
            assertEq(usdc.balanceOf(j.client), before + j.budget, "full refund");
            vm.revertToState(snap);
        }
    }
}
