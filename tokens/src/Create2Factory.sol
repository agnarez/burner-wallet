// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Create2Factory — minimal CREATE2 deployment factory
/// @notice Bootstrap infrastructure for the $AGNA vanity deployment.
/// The token contract must be deployed at an address starting with
/// 0xa69000, but a contract address can only be chosen with CREATE2 —
/// so a factory must exist first, and the factory is deployed by the
/// burner wallet with a normal CREATE transaction. That means the
/// factory's OWN address is keccak256(burner, nonce) and CANNOT carry
/// the vanity prefix: it is deployed from a fixed address, so there is
/// nothing to mine against. This is inherent, not a bug — only the
/// contracts the factory deploys (the token, and through the token the
/// NameSBT registry) carry the 0xa69000 prefix.
/// @dev Permissionless: anyone may deploy through it. The mined salts
/// are what make the deployed addresses vanity — the factory adds no
/// access control and holds no funds. Deployed with value 0 only in
/// the AGNA flow (the payable flag exists so the same factory can be
/// reused for value-carrying deployments elsewhere).
contract Create2Factory {
    event Deployed(address indexed deployed, bytes32 indexed salt);

    error Create2DeployFailed();

    /// @notice Deploy `initCode` via CREATE2 with `salt` as the salt.
    /// @dev Reverts if CREATE2 returns address(0) (e.g. the salt was
    /// already used for this init code, or the init code is invalid).
    function deploy(bytes memory initCode, bytes32 salt) external payable returns (address deployed) {
        assembly {
            deployed := create2(callvalue(), add(initCode, 0x20), mload(initCode), salt)
        }
        if (deployed == address(0)) revert Create2DeployFailed();
        emit Deployed(deployed, salt);
    }

    /// @notice Predict the address `deploy` would create for this init
    /// code hash and salt. Used by the off-chain vanity salt miner.
    function predict(bytes32 initCodeHash, bytes32 salt) external view returns (address) {
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))
            )
        );
    }
}
