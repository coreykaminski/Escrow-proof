// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20, ProofDeskJobs} from "../src/ProofDeskJobs.sol";
import {MockUSDC} from "../src/test/MockUSDC.sol";

/// Deploys ProofDeskJobs.
///   PAYMENT_TOKEN  USDC address (Base Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e).
///                  Unset → deploys MockUSDC (local anvil only).
///   TREASURY       fee recipient (default: the deployer)
///   FEE_BP         platform fee in basis points (default 200 = 2%, max 500)
///   OWNER          admin (default: the deployer). On Base mainnet it's required and must be a
///                  multisig, not the deployer (docs/security/evaluator-keys.md).
/// forge script script/Deploy.s.sol --rpc-url $CHAIN_RPC_URL --private-key $DEPLOYER_KEY --broadcast
contract Deploy is Script {
    function run() external returns (ProofDeskJobs jobs) {
        vm.startBroadcast();
        address deployer = msg.sender;
        if (block.chainid == 8453) {
            address owner = vm.envAddress("OWNER");
            require(owner != deployer && owner.code.length > 0, "mainnet OWNER must be a multisig contract");
            require(vm.envAddress("TREASURY") != address(0), "mainnet TREASURY is required");
            require(vm.envAddress("PAYMENT_TOKEN") != address(0), "mainnet PAYMENT_TOKEN is required");
        }
        address token = vm.envOr("PAYMENT_TOKEN", address(0));
        if (token == address(0)) {
            token = address(new MockUSDC());
            console.log("MockUSDC", token);
        }
        jobs = new ProofDeskJobs(
            IERC20(token),
            vm.envOr("TREASURY", deployer),
            uint16(vm.envOr("FEE_BP", uint256(200))),
            vm.envOr("OWNER", deployer)
        );
        vm.stopBroadcast();
        console.log("ProofDeskJobs", address(jobs));
    }
}
