// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LedgerAnchor} from "../src/LedgerAnchor.sol";

contract LedgerAnchorTest is Test {
    LedgerAnchor a;
    address owner = makeAddr("owner");
    address anchorer = makeAddr("anchorer");

    function setUp() public {
        a = new LedgerAnchor(owner, anchorer);
    }

    function test_anchorsMoveForwardOnly() public {
        vm.startPrank(anchorer);
        a.anchor(10, keccak256("h10"));
        a.anchor(25, keccak256("h25"));
        vm.expectRevert(LedgerAnchor.NotForward.selector);
        a.anchor(25, keccak256("again"));
        vm.expectRevert(LedgerAnchor.NotForward.selector);
        a.anchor(3, keccak256("back"));
        vm.stopPrank();
        assertEq(a.count(), 2);
        assertEq(a.latest().seq, 25);
        assertEq(a.get(0).headHash, keccak256("h10"));
    }

    function test_onlyAnchorer() public {
        vm.prank(owner);
        vm.expectRevert(LedgerAnchor.Unauthorized.selector);
        a.anchor(1, keccak256("x"));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(LedgerAnchor.Unauthorized.selector);
        a.anchor(1, keccak256("x"));
    }

    function test_ownerRotatesAnchorer() public {
        address next = makeAddr("next");
        vm.prank(anchorer);
        vm.expectRevert(LedgerAnchor.Unauthorized.selector);
        a.setAnchorer(next);
        vm.prank(owner);
        a.setAnchorer(next);
        vm.prank(next);
        a.anchor(1, keccak256("x"));
        assertEq(a.count(), 1);
    }

    function testFuzz_historyIsImmutable(uint64[8] memory seqs) public {
        uint64 last;
        uint256 n;
        for (uint256 i = 0; i < seqs.length; i++) {
            vm.prank(anchorer);
            if (seqs[i] > last) {
                a.anchor(seqs[i], keccak256(abi.encode(i)));
                last = seqs[i];
                n++;
            } else {
                vm.expectRevert();
                a.anchor(seqs[i], keccak256(abi.encode(i)));
            }
        }
        assertEq(a.count(), n);
        for (uint256 i = 1; i < n; i++) assertGt(a.get(i).seq, a.get(i - 1).seq);
    }
}
