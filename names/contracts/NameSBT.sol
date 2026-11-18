// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {IERC5192} from "./interfaces/IERC5192.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/**
 * @title NameSBT
 * @notice Soul-bound name tokens (ERC-721 + ERC-5192 "locked" tokens).
 *
 * Each token represents one human-readable name, e.g. "agnarez.arc".
 * A name can only ever belong to one owner, and a token can never be
 * transferred — not by its owner, not by anyone else. It can only be
 * minted and burned. Burning frees the name so it can be minted again.
 *
 * Differences from ENS / Base names (see names/README.md):
 *  - ENS and Base names are ordinary transferable ERC-721s; these are
 *    locked (ERC-5192) and cannot move between wallets, ever.
 *  - ENS / Base names cost real registration fees on mainnet; minting
 *    here is free (gas only) and aimed at testnets.
 *  - This contract is a standalone registry, not part of the ENS or
 *    Base name systems — names here do not resolve in wallets or dapps
 *    the way .eth / .base.eth names do.
 *
 * Wallet roles (agnarez's setup):
 *  - The burner wallet owns this contract and signs mints (it holds
 *    an exportable key). It is set as the owner explicitly in the
 *    constructor — the deployer is the $AGNA token contract (CREATE2),
 *    not the burner, so ownership cannot default to msg.sender.
 *  - The Circle agent wallet is MPC-held by Circle (no exportable
 *    key), so it can only ever be a holder/recipient: the contract
 *    owner mints a name TO it with `mintTo`. It can never sign.
 */
contract NameSBT is ERC721, ERC721Enumerable, IERC5192, Ownable {
    error NameSBT__TransferBlocked();
    error NameSBT__ApprovalBlocked();
    error NameSBT__NameTaken(string name);
    error NameSBT__InvalidName(string name);
    error NameSBT__NotTokenOwner();
    error NameSBT__NotNameOwner();

    event NameMinted(
        address indexed owner,
        uint256 indexed tokenId,
        string name
    );
    event NameBurned(
        address indexed owner,
        uint256 indexed tokenId,
        string name
    );
    event PrimaryNameSet(
        address indexed owner,
        uint256 indexed tokenId,
        string name
    );

    uint256 private _nextTokenId = 1;

    /// name hash (keccak256 of the normalized name) -> token id, 0 = free.
    mapping(bytes32 => uint256) private _nameHashToTokenId;
    /// token id -> normalized name.
    mapping(uint256 => string) private _tokenIdToName;
    /// owner -> token id of their primary name, 0 = none.
    mapping(address => uint256) private _primaryTokenId;

    /// @param initialOwner_ the address that owns this contract (and
    /// can therefore mintTo). It is an explicit constructor argument —
    /// NOT msg.sender — because the contract is deployed by the $AGNA
    /// token contract via CREATE2 (the token contract is the deployer),
    /// and if ownership defaulted to msg.sender the token contract
    /// itself would own the registry and nobody could mint names.
    /// Pass the burner wallet here.
    constructor(
        string memory name_,
        string memory symbol_,
        address initialOwner_
    ) ERC721(name_, symbol_) Ownable(initialOwner_) {}
    // Note: Ownable's own constructor reverts with
    // OwnableInvalidOwner if initialOwner_ is the zero address, so
    // no separate check is needed here.

    // ------------------------------------------------------------------
    // Minting
    // ------------------------------------------------------------------

    /// @notice Mint a name for yourself (the caller becomes the owner).
    function mint(string calldata name) external returns (uint256 tokenId) {
        return _mintName(msg.sender, name);
    }

    /// @notice Mint a name for someone else. Only the contract owner
    /// (the deployer, i.e. the burner wallet) can do this — this is how
    /// a name is given to the Circle agent wallet, which cannot sign.
    function mintTo(
        address to,
        string calldata name
    ) external onlyOwner returns (uint256 tokenId) {
        return _mintName(to, name);
    }

    function _mintName(
        address to,
        string calldata name
    ) internal returns (uint256 tokenId) {
        (string memory normalized, bytes32 nameHash) = _normalizeName(name);
        if (_nameHashToTokenId[nameHash] != 0) {
            revert NameSBT__NameTaken(normalized);
        }
        tokenId = _nextTokenId++;
        _nameHashToTokenId[nameHash] = tokenId;
        _tokenIdToName[tokenId] = normalized;
        _safeMint(to, tokenId);
        emit Locked(tokenId);
        emit NameMinted(to, tokenId, normalized);
        // First name an owner holds becomes their primary name.
        if (_primaryTokenId[to] == 0) {
            _primaryTokenId[to] = tokenId;
            emit PrimaryNameSet(to, tokenId, normalized);
        }
    }

    // ------------------------------------------------------------------
    // Burning (the only way a token leaves its owner)
    // ------------------------------------------------------------------

    /// @notice Burn your own name token. The name becomes free and can
    /// be minted again by anyone.
    function burn(uint256 tokenId) external {
        address owner = _requireOwned(tokenId);
        if (owner != msg.sender) {
            revert NameSBT__NotTokenOwner();
        }
        string memory name = _tokenIdToName[tokenId];
        _nameHashToTokenId[keccak256(bytes(name))] = 0;
        delete _tokenIdToName[tokenId];
        if (_primaryTokenId[owner] == tokenId) {
            // Fall back to another name the owner still holds, if any.
            _primaryTokenId[owner] = balanceOf(owner) > 1
                ? tokenOfOwnerByIndex(owner, 0) == tokenId
                    ? tokenOfOwnerByIndex(owner, 1)
                    : tokenOfOwnerByIndex(owner, 0)
                : 0;
            emit PrimaryNameSet(
                owner,
                _primaryTokenId[owner],
                _primaryTokenId[owner] == 0
                    ? ""
                    : _tokenIdToName[_primaryTokenId[owner]]
            );
        }
        _burn(tokenId);
        emit NameBurned(owner, tokenId, name);
    }

    // ------------------------------------------------------------------
    // Primary name
    // ------------------------------------------------------------------

    /// @notice Choose which of your names is your primary (reverse) name.
    function setPrimary(uint256 tokenId) external {
        address owner = _requireOwned(tokenId);
        if (owner != msg.sender) {
            revert NameSBT__NotTokenOwner();
        }
        _primaryTokenId[msg.sender] = tokenId;
        emit PrimaryNameSet(msg.sender, tokenId, _tokenIdToName[tokenId]);
    }

    /// @notice Primary (reverse) name of an owner, or "" if they hold none.
    function primaryNameOf(address owner) external view returns (string memory) {
        uint256 tokenId = _primaryTokenId[owner];
        if (tokenId == 0) return "";
        return _tokenIdToName[tokenId];
    }

    /// @notice Token id of an owner's primary name, or 0 if they hold none.
    function primaryTokenIdOf(address owner) external view returns (uint256) {
        return _primaryTokenId[owner];
    }

    // ------------------------------------------------------------------
    // Resolution lookups
    // ------------------------------------------------------------------

    /// @notice Forward resolution: who owns this name? address(0) if free.
    function resolveName(string calldata name) external view returns (address) {
        (, bytes32 nameHash) = _normalizeName(name);
        uint256 tokenId = _nameHashToTokenId[nameHash];
        if (tokenId == 0) return address(0);
        return ownerOf(tokenId);
    }

    /// @notice Name registered for a token id. Reverts if it does not exist.
    function nameOf(uint256 tokenId) external view returns (string memory) {
        _requireOwned(tokenId);
        return _tokenIdToName[tokenId];
    }

    /// @notice Token id for a name, or 0 if the name is free.
    function tokenIdOf(string calldata name) external view returns (uint256) {
        (, bytes32 nameHash) = _normalizeName(name);
        return _nameHashToTokenId[nameHash];
    }

    /// @notice True if a name is already taken.
    function isNameTaken(string calldata name) external view returns (bool) {
        (, bytes32 nameHash) = _normalizeName(name);
        return _nameHashToTokenId[nameHash] != 0;
    }

    // ------------------------------------------------------------------
    // ERC-5192 (locked / soul-bound)
    // ------------------------------------------------------------------

    /// @notice ERC-5192: always true for an existing token — this token
    /// can never be transferred. Returns false for a nonexistent token.
    function locked(uint256 tokenId) external view returns (bool) {
        return _ownerOf(tokenId) != address(0);
    }

    // ------------------------------------------------------------------
    // Soul-bound enforcement
    // ------------------------------------------------------------------

    /// @dev Block every transfer. Minting (from == 0) and burning
    /// (to == 0) are the only allowed movements.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    )
        internal
        override(ERC721, ERC721Enumerable)
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            revert NameSBT__TransferBlocked();
        }
        return super._update(to, tokenId, auth);
    }

    /// @dev Approvals are meaningless on a token that can never move.
    function approve(
        address /* to */,
        uint256 /* tokenId */
    ) public virtual override(ERC721, IERC721) {
        revert NameSBT__ApprovalBlocked();
    }

    /// @dev See {approve}.
    function setApprovalForAll(
        address /* operator */,
        bool /* approved */
    ) public virtual override(ERC721, IERC721) {
        revert NameSBT__ApprovalBlocked();
    }

    function _increaseBalance(
        address account,
        uint128 value
    ) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function supportsInterface(
        bytes4 interfaceId
    )
        public
        view
        override(ERC721, ERC721Enumerable, IERC165)
        returns (bool)
    {
        return
            interfaceId == type(IERC5192).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------
    // Metadata
    // ------------------------------------------------------------------

    /// @notice On-chain JSON metadata (base64 data URI). Names are
    /// restricted to [a-z0-9.-] so no JSON escaping is ever needed.
    function tokenURI(
        uint256 tokenId
    ) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory name = _tokenIdToName[tokenId];
        string memory json = string.concat(
            '{"name":"',
            name,
            '",',
            '"description":"Soul-bound name token (ERC-5192). Non-transferable; bound to its owner forever.",',
            '"attributes":[',
            '{"trait_type":"name","value":"',
            name,
            '"},',
            '{"trait_type":"locked","value":"true"}',
            "]}"
        );
        return
            string.concat(
                "data:application/json;base64,",
                Base64.encode(bytes(json))
            );
    }

    // ------------------------------------------------------------------
    // Name rules
    // ------------------------------------------------------------------

    /// @dev Normalize a name: lowercase it, check the charset and shape.
    /// Returns the normalized name and its hash (the uniqueness key).
    /// Rules: 3-64 chars, [a-z0-9.-] only, no leading/trailing dot or
    /// hyphen, no "..". Uppercase input is accepted and lowercased.
    function _normalizeName(
        string memory name
    ) internal pure returns (string memory normalized, bytes32 nameHash) {
        bytes memory raw = bytes(name);
        if (raw.length < 3 || raw.length > 64) {
            revert NameSBT__InvalidName(name);
        }
        bytes memory out = new bytes(raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 c = raw[i];
            if (c >= 0x41 && c <= 0x5A) {
                c = bytes1(uint8(c) + 32); // A-Z -> a-z
            }
            bool ok = (c >= 0x61 && c <= 0x7A) || // a-z
                (c >= 0x30 && c <= 0x39) || // 0-9
                c == 0x2D || // -
                c == 0x2E; // .
            if (!ok) {
                revert NameSBT__InvalidName(name);
            }
            out[i] = c;
        }
        if (
            out[0] == 0x2E ||
            out[0] == 0x2D ||
            out[out.length - 1] == 0x2E ||
            out[out.length - 1] == 0x2D
        ) {
            revert NameSBT__InvalidName(name);
        }
        for (uint256 i = 1; i < out.length; i++) {
            if (out[i] == 0x2E && out[i - 1] == 0x2E) {
                revert NameSBT__InvalidName(name);
            }
        }
        normalized = string(out);
        nameHash = keccak256(out);
    }
}
