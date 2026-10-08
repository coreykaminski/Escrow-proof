// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC8183} from "../src/IERC8183.sol";
import {IERC20, ProofDeskJobs} from "../src/ProofDeskJobs.sol";
import {MockUSDC} from "../src/test/MockUSDC.sol";

contract ProofDeskJobsTest is Test {
    MockUSDC usdc;
    ProofDeskJobs jobs;

    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address evaluator = makeAddr("evaluator");
    address provider = makeAddr("provider");
    address stranger = makeAddr("stranger");
    uint256 clientKey = 0xC11E47;
    address client;

    uint256 constant BUDGET = 180e6; // 180 USDC
    uint16 constant FEE_BP = 200; // 2%
    string constant DESC = "proofdesk:agr_test:spec:abc";

    function setUp() public {
        vm.warp(1_800_000_000);
        client = vm.addr(clientKey);
        usdc = new MockUSDC();
        jobs = new ProofDeskJobs(IERC20(address(usdc)), treasury, FEE_BP, owner);
        usdc.mint(client, 10_000e6);
        vm.prank(client);
        usdc.approve(address(jobs), type(uint256).max);
    }

    function _expiry() internal view returns (uint256) {
        return block.timestamp + 7 days;
    }

    function _funded() internal returns (uint256 id) {
        vm.prank(client);
        id = jobs.createAndFund(provider, evaluator, _expiry(), DESC, BUDGET);
    }

    // --- Standard ERC-8183 flow ---

    function test_standardFlow_completePaysProviderMinusFee() public {
        vm.prank(client);
        uint256 id = jobs.createJob(provider, evaluator, _expiry(), DESC, address(0));
        vm.prank(provider);
        jobs.setBudget(id, BUDGET, "");
        vm.prank(client);
        jobs.fund(id, abi.encode(BUDGET));
        assertEq(usdc.balanceOf(address(jobs)), BUDGET);
        vm.prank(provider);
        jobs.submit(id, keccak256("deliverable"), "");
        vm.prank(evaluator);
        jobs.complete(id, bytes32("ok"), "");

        uint256 fee = BUDGET * FEE_BP / 10_000;
        assertEq(usdc.balanceOf(provider), BUDGET - fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(address(jobs)), 0);
        assertEq(jobs.totalEscrowed(), 0);
        assertEq(uint8(jobs.getJob(id).status), uint8(IERC8183.JobStatus.Completed));
    }

    function test_fund_rejectsBudgetChangedAfterClientSigned() public {
        vm.prank(client);
        uint256 id = jobs.createJob(provider, evaluator, _expiry(), DESC, address(0));
        vm.prank(provider);
        jobs.setBudget(id, BUDGET * 2, "");
        vm.prank(client);
        vm.expectRevert(ProofDeskJobs.BudgetMismatch.selector);
        jobs.fund(id, abi.encode(BUDGET));
    }

    function test_fund_needsProviderAndBudget() public {
        vm.prank(client);
        uint256 id = jobs.createJob(address(0), evaluator, _expiry(), DESC, address(0));
        vm.prank(client);
        vm.expectRevert(ProofDeskJobs.InvalidState.selector);
        jobs.fund(id, "");
        vm.prank(client);
        jobs.setProvider(id, provider);
        vm.prank(client);
        vm.expectRevert(ProofDeskJobs.InvalidState.selector); // budget still zero
        jobs.fund(id, "");
    }

    function test_rejectOpenJob_byClientOnly() public {
        vm.prank(client);
        uint256 id = jobs.createJob(provider, evaluator, _expiry(), DESC, address(0));
        vm.prank(evaluator);
        vm.expectRevert(ProofDeskJobs.Unauthorized.selector);
        jobs.reject(id, "", "");
        vm.prank(client);
        jobs.reject(id, "", "");
        assertEq(uint8(jobs.getJob(id).status), uint8(IERC8183.JobStatus.Rejected));
    }

    function test_evaluatorReject_refundsInFull_noFee() public {
        uint256 id = _funded();
        uint256 before = usdc.balanceOf(client);
        vm.prank(evaluator);
        jobs.reject(id, bytes32("bad"), "");
        assertEq(usdc.balanceOf(client), before + BUDGET);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_createJob_validation() public {
        vm.startPrank(client);
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector); // hooks unsupported
        jobs.createJob(provider, evaluator, _expiry(), DESC, address(0xBEEF));
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector); // expiry too soon
        jobs.createJob(provider, evaluator, block.timestamp + 5 minutes, DESC, address(0));
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector); // client can't evaluate itself
        jobs.createJob(provider, client, _expiry(), DESC, address(0));
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector); // provider can't evaluate itself
        jobs.createJob(provider, provider, _expiry(), DESC, address(0));
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector); // client can't be provider
        jobs.createJob(client, evaluator, _expiry(), DESC, address(0));
        vm.stopPrank();
    }

    // --- Proof Desk settle ---

    function test_settle_partialSplit() public {
        uint256 id = _funded();
        uint256 clientBefore = usdc.balanceOf(client);
        vm.prank(evaluator);
        jobs.settle(id, 6_000, bytes32("ledger-hash"));
        uint256 released = BUDGET * 6_000 / 10_000;
        uint256 fee = released * FEE_BP / 10_000;
        assertEq(usdc.balanceOf(provider), released - fee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(usdc.balanceOf(client), clientBefore + BUDGET - released);
        assertEq(usdc.balanceOf(address(jobs)), 0);
    }

    function test_settle_fromFundedWithoutProviderTx() public {
        uint256 id = _funded();
        vm.prank(evaluator);
        jobs.settle(id, 10_000, bytes32("release"));
        assertEq(uint8(jobs.getJob(id).status), uint8(IERC8183.JobStatus.Completed));
    }

    function test_settle_onlyEvaluator() public {
        uint256 id = _funded();
        address[4] memory others = [client, provider, owner, stranger];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(ProofDeskJobs.Unauthorized.selector);
            jobs.settle(id, 10_000, "");
        }
    }

    function test_settle_cannotPayProviderAfterExpiry_butCanRefund() public {
        uint256 id = _funded();
        vm.warp(jobs.getJob(id).expiredAt);
        vm.prank(evaluator);
        vm.expectRevert(ProofDeskJobs.Expired.selector);
        jobs.settle(id, 10_000, "");
        vm.prank(evaluator);
        jobs.settle(id, 0, "");
        assertEq(uint8(jobs.getJob(id).status), uint8(IERC8183.JobStatus.Rejected));
    }

    function test_settle_twiceFails() public {
        uint256 id = _funded();
        vm.prank(evaluator);
        jobs.settle(id, 10_000, "");
        vm.prank(evaluator);
        vm.expectRevert(ProofDeskJobs.InvalidState.selector);
        jobs.settle(id, 0, "");
    }

    function test_settle_rejectsOver100Percent() public {
        uint256 id = _funded();
        vm.prank(evaluator);
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        jobs.settle(id, 10_001, "");
    }

    // --- Expiry ---

    function test_claimRefund_anyoneAfterExpiry() public {
        uint256 id = _funded();
        vm.prank(stranger);
        vm.expectRevert(ProofDeskJobs.NotExpired.selector);
        jobs.claimRefund(id);
        vm.warp(jobs.getJob(id).expiredAt);
        uint256 before = usdc.balanceOf(client);
        vm.prank(stranger);
        jobs.claimRefund(id);
        assertEq(usdc.balanceOf(client), before + BUDGET);
        assertEq(uint8(jobs.getJob(id).status), uint8(IERC8183.JobStatus.Expired));
    }

    function test_completeAfterExpiry_reverts() public {
        uint256 id = _funded();
        vm.prank(provider);
        jobs.submit(id, bytes32("d"), "");
        vm.warp(jobs.getJob(id).expiredAt);
        vm.prank(evaluator);
        vm.expectRevert(ProofDeskJobs.Expired.selector);
        jobs.complete(id, "", "");
    }

    // --- Fees and admin ---

    function test_feeSnapshotAtCreation() public {
        uint256 id = _funded();
        vm.prank(owner);
        jobs.setFee(500);
        vm.prank(evaluator);
        jobs.settle(id, 10_000, "");
        assertEq(usdc.balanceOf(treasury), BUDGET * FEE_BP / 10_000);
    }

    function test_admin_onlyOwner_andCapped() public {
        vm.prank(stranger);
        vm.expectRevert(ProofDeskJobs.Unauthorized.selector);
        jobs.setFee(100);
        vm.prank(owner);
        vm.expectRevert(ProofDeskJobs.InvalidParams.selector);
        jobs.setFee(501);
        vm.prank(stranger);
        vm.expectRevert(ProofDeskJobs.Unauthorized.selector);
        jobs.setTreasury(stranger);
    }

    // --- Gasless funding (EIP-3009) ---

    function _authSig(uint256 key, address from, uint256 value, bytes32 nonce, uint256 validBefore)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                from,
                address(jobs),
                value,
                uint256(0),
                validBefore,
                nonce
            )
        );
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_createAndFundWithAuthorization_relayedByAnyone() public {
        uint256 exp = _expiry();
        bytes32 nonce = jobs.authorizationNonce(client, provider, evaluator, exp, DESC, BUDGET);
        (uint8 v, bytes32 r, bytes32 s) = _authSig(clientKey, client, BUDGET, nonce, exp);
        vm.prank(stranger); // the relayer pays gas; the client signs only
        uint256 id = jobs.createAndFundWithAuthorization(
            client, provider, evaluator, exp, DESC, BUDGET, 0, exp, v, r, s
        );
        IERC8183.Job memory j = jobs.getJob(id);
        assertEq(j.client, client);
        assertEq(uint8(j.status), uint8(IERC8183.JobStatus.Funded));
        assertEq(usdc.balanceOf(address(jobs)), BUDGET);
    }

    function test_authorization_cannotBeRedirectedToOtherTerms() public {
        uint256 exp = _expiry();
        bytes32 nonce = jobs.authorizationNonce(client, provider, evaluator, exp, DESC, BUDGET);
        (uint8 v, bytes32 r, bytes32 s) = _authSig(clientKey, client, BUDGET, nonce, exp);
        // A relayer swapping in its own provider changes the nonce, so the signature fails.
        vm.prank(stranger);
        vm.expectRevert(bytes("invalid signature"));
        jobs.createAndFundWithAuthorization(
            client, stranger, evaluator, exp, DESC, BUDGET, 0, exp, v, r, s
        );
    }

    function test_authorization_singleUse() public {
        uint256 exp = _expiry();
        bytes32 nonce = jobs.authorizationNonce(client, provider, evaluator, exp, DESC, BUDGET);
        (uint8 v, bytes32 r, bytes32 s) = _authSig(clientKey, client, BUDGET, nonce, exp);
        jobs.createAndFundWithAuthorization(client, provider, evaluator, exp, DESC, BUDGET, 0, exp, v, r, s);
        vm.expectRevert(bytes("authorization used"));
        jobs.createAndFundWithAuthorization(client, provider, evaluator, exp, DESC, BUDGET, 0, exp, v, r, s);
    }

    // --- Fuzz ---

    function testFuzz_settleConservesFunds(uint96 budget, uint16 releaseBP, uint16 feeBP) public {
        budget = uint96(bound(budget, 1, 1_000_000e6));
        releaseBP = uint16(bound(releaseBP, 0, 10_000));
        feeBP = uint16(bound(feeBP, 0, 500));
        vm.prank(owner);
        jobs.setFee(feeBP);
        usdc.mint(client, budget);
        uint256 clientBefore = usdc.balanceOf(client);
        vm.prank(client);
        uint256 id = jobs.createAndFund(provider, evaluator, _expiry(), DESC, budget);
        vm.prank(evaluator);
        jobs.settle(id, releaseBP, "");
        uint256 total =
            usdc.balanceOf(client) + usdc.balanceOf(provider) + usdc.balanceOf(treasury);
        assertEq(total, clientBefore, "funds conserved");
        assertEq(usdc.balanceOf(address(jobs)), 0);
        assertLe(usdc.balanceOf(treasury), uint256(budget) * 500 / 10_000, "fee capped at 5%");
    }
}
