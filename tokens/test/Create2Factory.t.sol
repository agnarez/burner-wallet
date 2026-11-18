// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Create2Factory} from "../src/Create2Factory.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

/// @notice Unit tests for the minimal CREATE2 factory used as the
/// bootstrap for the $AGNA vanity deployment.
contract Create2FactoryTest is Test {
    Create2Factory internal factory;

    function setUp() public {
        factory = new Create2Factory();
    }

    function _mockInitCode() internal pure returns (bytes memory) {
        return abi.encodePacked(type(MockERC20).creationCode, abi.encode("Factory Token", "FT"));
    }

    function testDeployAndPredict() public {
        bytes memory initCode = _mockInitCode();
        bytes32 salt = bytes32(uint256(0xabcd));
        address predicted = factory.predict(keccak256(initCode), salt);
        address deployed = factory.deploy(initCode, salt);
        assertEq(deployed, predicted, "deployed address matches prediction");
        assertGt(deployed.code.length, 0, "deployed contract has code");
        assertEq(MockERC20(deployed).name(), "Factory Token", "deployed contract works");
    }

    function testDeploySameSaltTwiceFails() public {
        bytes memory initCode = _mockInitCode();
        bytes32 salt = bytes32(uint256(0xabcd));
        factory.deploy(initCode, salt);
        vm.expectRevert(Create2Factory.Create2DeployFailed.selector);
        factory.deploy(initCode, salt);
    }

    function testPredictMatchesCreate2Formula() public {
        // Independent recomputation of the CREATE2 address, not via the
        // contract's own predict() — guards against a wrong formula.
        bytes memory initCode = _mockInitCode();
        bytes32 salt = bytes32(uint256(0x9999));
        bytes32 initCodeHash = keccak256(initCode);
        address expected = address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, initCodeHash)))
            )
        );
        assertEq(factory.predict(initCodeHash, salt), expected, "predict matches the CREATE2 formula");
        assertEq(factory.deploy(initCode, salt), expected, "deployed address matches the formula");
    }
}
