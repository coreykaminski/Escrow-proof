// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title Proof Desk ledger anchor
/// @notice Proof Desk's decision ledger is a hash chain in its database. Every day the head of
/// that chain (sequence number + entry hash) is posted here, so anyone holding an exported
/// ledger, or a verdict report, can check that history up to that point was never rewritten.
/// Anchors only move forward; nothing can be changed or removed once posted.
contract LedgerAnchor {
    struct Anchor {
        uint64 seq;
        uint64 timestamp;
        bytes32 headHash;
    }

    address public owner;
    address public anchorer;
    Anchor[] internal _anchors;

    event Anchored(uint256 indexed index, uint64 indexed seq, bytes32 headHash, uint64 timestamp);
    event AnchorerChanged(address anchorer);
    event OwnerChanged(address owner);

    error Unauthorized();
    error NotForward();
    error InvalidParams();

    constructor(address owner_, address anchorer_) {
        if (owner_ == address(0) || anchorer_ == address(0)) revert InvalidParams();
        owner = owner_;
        anchorer = anchorer_;
    }

    function anchor(uint64 seq, bytes32 headHash) external returns (uint256 index) {
        if (msg.sender != anchorer) revert Unauthorized();
        if (seq == 0 || headHash == bytes32(0)) revert InvalidParams();
        uint256 n = _anchors.length;
        if (n > 0 && seq <= _anchors[n - 1].seq) revert NotForward();
        _anchors.push(Anchor({seq: seq, timestamp: uint64(block.timestamp), headHash: headHash}));
        emit Anchored(n, seq, headHash, uint64(block.timestamp));
        return n;
    }

    function count() external view returns (uint256) {
        return _anchors.length;
    }

    function get(uint256 index) external view returns (Anchor memory) {
        return _anchors[index];
    }

    function latest() external view returns (Anchor memory a) {
        uint256 n = _anchors.length;
        if (n > 0) a = _anchors[n - 1];
    }

    function setAnchorer(address anchorer_) external {
        if (msg.sender != owner) revert Unauthorized();
        if (anchorer_ == address(0)) revert InvalidParams();
        anchorer = anchorer_;
        emit AnchorerChanged(anchorer_);
    }

    function transferOwnership(address owner_) external {
        if (msg.sender != owner) revert Unauthorized();
        if (owner_ == address(0)) revert InvalidParams();
        owner = owner_;
        emit OwnerChanged(owner_);
    }
}
