import { expect } from "chai";
import { network } from "hardhat";

describe("NameSBT", function () {
  let ethers;
  let sbt;
  let deployer;
  let alice;
  let bob;

  before(async function () {
    ({ ethers } = await network.getOrCreate());
    [deployer, alice, bob] = await ethers.getSigners();
    sbt = await ethers.deployContract("NameSBT", [
      "Burner Names",
      "BNAME",
      deployer.address,
    ]);
    await sbt.waitForDeployment();
  });

  describe("ownership", function () {
    it("sets the explicit initial owner (not the deployer)", async function () {
      expect(await sbt.owner()).to.equal(deployer.address);
      // A second registry owned by someone else: the deployer is NOT
      // the owner, so it cannot mintTo there. This is the case that
      // matters for the vanity flow — the $AGNA token contract deploys
      // the registry, and the burner is the explicit owner.
      const other = await ethers.deployContract("NameSBT", [
        "Other Names",
        "ONAME",
        alice.address,
      ]);
      await other.waitForDeployment();
      expect(await other.owner()).to.equal(alice.address);
      await expect(
        other.connect(deployer).mintTo(bob.address, "notyours.arc"),
      ).to.be.revertedWithCustomError(other, "OwnableUnauthorizedAccount");
      const tx = await other.connect(alice).mintTo(bob.address, "bobs.arc");
      await expect(tx)
        .to.emit(other, "NameMinted")
        .withArgs(bob.address, 1, "bobs.arc");
    });

    it("rejects the zero address as initial owner", async function () {
      // Send the creation transaction directly so the revert can be
      // asserted on the transaction (deployContract's promise rejects
      // before the matcher can see the revert reason).
      const factory = await ethers.getContractFactory("NameSBT");
      const tx = await factory.getDeployTransaction(
        "Burner Names",
        "BNAME",
        ethers.ZeroAddress,
      );
      // OpenZeppelin's Ownable constructor rejects the zero address
      // with OwnableInvalidOwner.
      await expect(deployer.sendTransaction(tx)).to.be.revertedWithCustomError(
        sbt,
        "OwnableInvalidOwner",
      );
    });
  });

  describe("mint", function () {
    it("mints a name, records the owner, and sets it as primary", async function () {
      const tx = await sbt.connect(alice).mint("agnarez.arc");
      await expect(tx)
        .to.emit(sbt, "NameMinted")
        .withArgs(alice.address, 1, "agnarez.arc");
      await expect(tx)
        .to.emit(sbt, "Locked")
        .withArgs(1);
      expect(await sbt.ownerOf(1)).to.equal(alice.address);
      expect(await sbt.nameOf(1)).to.equal("agnarez.arc");
      expect(await sbt.tokenIdOf("agnarez.arc")).to.equal(1);
      expect(await sbt.resolveName("agnarez.arc")).to.equal(alice.address);
      expect(await sbt.primaryNameOf(alice.address)).to.equal("agnarez.arc");
      expect(await sbt.primaryTokenIdOf(alice.address)).to.equal(1);
      expect(await sbt.isNameTaken("agnarez.arc")).to.equal(true);
      expect(await sbt.balanceOf(alice.address)).to.equal(1);
    });

    it("normalizes names to lowercase", async function () {
      await sbt.connect(bob).mint("Bob.ARC");
      expect(await sbt.nameOf(2)).to.equal("bob.arc");
      expect(await sbt.resolveName("BOB.arc")).to.equal(bob.address);
    });

    it("rejects invalid names", async function () {
      const bad = ["", "ab", "a".repeat(65), "a b", "a_b", ".abc", "abc.", "-abc", "abc-", "a..b", "abc!"];
      for (const name of bad) {
        await expect(sbt.connect(bob).mint(name))
          .to.be.revertedWithCustomError(sbt, "NameSBT__InvalidName")
          .withArgs(name);
      }
    });

    it("lets the owner mint a name to someone else (e.g. the agent wallet)", async function () {
      // A fresh address with no names yet — stand-in for the Circle agent wallet.
      const agent = ethers.Wallet.createRandom().address;
      await expect(sbt.mintTo(agent, "agent.arc"))
        .to.emit(sbt, "NameMinted")
        .withArgs(agent, 3, "agent.arc");
      expect(await sbt.ownerOf(3)).to.equal(agent);
      expect(await sbt.primaryNameOf(agent)).to.equal("agent.arc");
    });

    it("forbids non-owners from minting to someone else", async function () {
      await expect(
        sbt.connect(alice).mintTo(bob.address, "sneaky.arc"),
      ).to.be.revertedWithCustomError(sbt, "OwnableUnauthorizedAccount");
    });
  });

  describe("soul-bound: transfers blocked", function () {
    it("blocks transferFrom", async function () {
      await expect(
        sbt.connect(alice).transferFrom(alice.address, bob.address, 1),
      ).to.be.revertedWithCustomError(sbt, "NameSBT__TransferBlocked");
    });

    it("blocks safeTransferFrom (both overloads)", async function () {
      await expect(
        sbt
          .connect(alice)
          ["safeTransferFrom(address,address,uint256)"](
            alice.address,
            bob.address,
            1,
          ),
      ).to.be.revertedWithCustomError(sbt, "NameSBT__TransferBlocked");
      await expect(
        sbt
          .connect(alice)
          ["safeTransferFrom(address,address,uint256,bytes)"](
            alice.address,
            bob.address,
            1,
            "0x",
          ),
      ).to.be.revertedWithCustomError(sbt, "NameSBT__TransferBlocked");
    });

    it("blocks approvals (useless on a token that can never move)", async function () {
      await expect(sbt.connect(alice).approve(bob.address, 1))
        .to.be.revertedWithCustomError(sbt, "NameSBT__ApprovalBlocked");
      await expect(sbt.connect(alice).setApprovalForAll(bob.address, true))
        .to.be.revertedWithCustomError(sbt, "NameSBT__ApprovalBlocked");
    });

    it("reports locked() true and ERC-5192 interface support", async function () {
      expect(await sbt.locked(1)).to.equal(true);
      expect(await sbt.locked(9999)).to.equal(false);
      // ERC-5192 interface id 0xb45a3c0e
      expect(await sbt.supportsInterface("0xb45a3c0e")).to.equal(true);
      // ERC-721 interface id 0x80ac58cd
      expect(await sbt.supportsInterface("0x80ac58cd")).to.equal(true);
    });
  });

  describe("name uniqueness", function () {
    it("rejects a second mint of the same name", async function () {
      await expect(sbt.connect(bob).mint("agnarez.arc"))
        .to.be.revertedWithCustomError(sbt, "NameSBT__NameTaken")
        .withArgs("agnarez.arc");
    });

    it("treats names as case-insensitive for uniqueness", async function () {
      await expect(sbt.connect(bob).mint("AGNAREZ.ARC"))
        .to.be.revertedWithCustomError(sbt, "NameSBT__NameTaken")
        .withArgs("agnarez.arc");
    });
  });

  describe("resolution lookups", function () {
    it("resolves forward and reverse, and switches primary", async function () {
      await sbt.connect(alice).mint("alice.arc");
      expect(await sbt.resolveName("alice.arc")).to.equal(alice.address);
      expect(await sbt.primaryNameOf(alice.address)).to.equal("agnarez.arc");
      await expect(sbt.connect(alice).setPrimary(4))
        .to.emit(sbt, "PrimaryNameSet")
        .withArgs(alice.address, 4, "alice.arc");
      expect(await sbt.primaryNameOf(alice.address)).to.equal("alice.arc");
      expect(await sbt.primaryTokenIdOf(alice.address)).to.equal(4);
    });

    it("returns empty / zero for unknown names and owners", async function () {
      expect(await sbt.resolveName("nobody.arc")).to.equal(ethers.ZeroAddress);
      expect(await sbt.tokenIdOf("nobody.arc")).to.equal(0);
      expect(await sbt.isNameTaken("nobody.arc")).to.equal(false);
      expect(await sbt.primaryNameOf(deployer.address)).to.equal("");
      expect(await sbt.primaryTokenIdOf(deployer.address)).to.equal(0);
    });

    it("only the owner can change their primary name", async function () {
      await expect(
        sbt.connect(bob).setPrimary(4),
      ).to.be.revertedWithCustomError(sbt, "NameSBT__NotTokenOwner");
    });
  });

  describe("burn", function () {
    it("frees the name so it can be minted again", async function () {
      await expect(sbt.connect(alice).burn(4))
        .to.emit(sbt, "NameBurned")
        .withArgs(alice.address, 4, "alice.arc");
      expect(await sbt.isNameTaken("alice.arc")).to.equal(false);
      expect(await sbt.resolveName("alice.arc")).to.equal(ethers.ZeroAddress);
      // Primary falls back to the name alice still holds.
      expect(await sbt.primaryNameOf(alice.address)).to.equal("agnarez.arc");
      // And the freed name can be re-minted by someone else.
      await sbt.connect(bob).mint("alice.arc");
      expect(await sbt.resolveName("alice.arc")).to.equal(bob.address);
    });

    it("only the owner can burn", async function () {
      await expect(
        sbt.connect(bob).burn(1),
      ).to.be.revertedWithCustomError(sbt, "NameSBT__NotTokenOwner");
    });
  });

  describe("metadata", function () {
    it("returns on-chain JSON metadata naming the token", async function () {
      const uri = await sbt.tokenURI(1);
      expect(uri.startsWith("data:application/json;base64,")).to.equal(true);
      const json = JSON.parse(
        Buffer.from(uri.replace("data:application/json;base64,", ""), "base64").toString("utf8"),
      );
      expect(json.name).to.equal("agnarez.arc");
      expect(json.attributes).to.deep.include({
        trait_type: "name",
        value: "agnarez.arc",
      });
      expect(json.attributes).to.deep.include({
        trait_type: "locked",
        value: "true",
      });
    });
  });
});
