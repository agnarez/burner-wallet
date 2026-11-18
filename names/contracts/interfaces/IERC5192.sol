// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title IERC5192 — Minimal Soulbound NFTs (EIP-5192)
/// @notice OpenZeppelin does not ship this interface, so it is defined
/// here verbatim from EIP-5192. Interface id: 0xb45a3c0e.
/// A locked token cannot be transferred, approved, or otherwise moved.
/// `Locked` is emitted when a token becomes locked (here: at mint).
/// `Unlocked` is emitted when a token becomes unlocked (never here).
interface IERC5192 is IERC721 {
    event Locked(uint256 indexed tokenId);
    event Unlocked(uint256 indexed tokenId);

    function locked(uint256 tokenId) external view returns (bool);
}
