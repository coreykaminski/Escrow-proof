// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {LedgerAnchor} from "../src/LedgerAnchor.sol";

/// Deploys LedgerAnchor.
///   ANCHORER  address allowed to post anchors (Proof Desk's anchor/evaluator key)
///   OWNER     can rotate the anchorer (default: the deployer; use a multisig in production)
/// forge script script/DeployAnchor.s.sol --rpc-url $CHAIN_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY --broadcast
contract DeployAnchor is Script {
    function run() external returns (LedgerAnchor a) {
        vm.startBroadcast();
        if (block.chainid == 8453) {
            address owner = vm.envAddress("OWNER");
            require(owner != msg.sender && owner.code.length > 0, "mainnet OWNER must be a multisig contract");
        }
        a = new LedgerAnchor(vm.envOr("OWNER", msg.sender), vm.envAddress("ANCHORER"));
        vm.stopBroadcast();
        console.log("LedgerAnchor", address(a));
    }
}
