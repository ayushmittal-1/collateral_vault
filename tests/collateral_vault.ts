import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CollateralVault } from "../target/types/collateral_vault";
import {
  getOrCreateAssociatedTokenAccount,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";
import { expect } from "chai"; // Import expect for error testing

describe("collateral_vault", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .CollateralVault as Program<CollateralVault>;
  const user = provider.wallet as anchor.Wallet;

  // This is the account that represents our "trading program"
  const tradingAuthority = anchor.web3.Keypair.generate();

  let usdtMint: anchor.web3.PublicKey;
  let userTokenAccount: anchor.web3.PublicKey;
  let vaultPda: anchor.web3.PublicKey;
  let vaultTokenAccountPda: anchor.web3.PublicKey;

  // Define amounts
  const MINT_AMOUNT = 1000 * 10 ** 6; // 1000 USDT
  const DEPOSIT_AMOUNT = new anchor.BN(100 * 10 ** 6); // 100 USDT
  const WITHDRAW_AMOUNT = new anchor.BN(50 * 10 ** 6); // 50 USDT
  const LOCK_AMOUNT = new anchor.BN(25 * 10 ** 6); // 25 USDT

  before(async () => {
    // Airdrop SOL to our new trading authority so it can sign
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        tradingAuthority.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );

    // Create a fake USDT Mint
    const mintAuthority = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(
        mintAuthority.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      )
    );
    usdtMint = await createMint(
      provider.connection,
      user.payer, mintAuthority.publicKey, null, 6
    );

    // Create the user's token account
    const userTokenAccountInfo = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user.payer, usdtMint, user.publicKey
    );
    userTokenAccount = userTokenAccountInfo.address;

    // Mint 1000 fake USDT to the user
    await mintTo(
      provider.connection,
      user.payer, usdtMint, userTokenAccount,
      mintAuthority, MINT_AMOUNT
    );

    // Find our PDA addresses
    [vaultPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), user.publicKey.toBuffer()],
      program.programId
    );

    [vaultTokenAccountPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("token"), vaultPda.toBuffer()],
        program.programId
      );
  });

  it("Initializes the vault!", async () => {
    const tx = await program.methods
      .initializeVault()
      .accounts({
        user: user.publicKey,
        tradingAuthority: tradingAuthority.publicKey,
        vault: vaultPda,
        vaultTokenAccount: vaultTokenAccountPda,
        usdtMint: usdtMint,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    console.log("Initialize vault transaction signature", tx);

    const vaultAccount = await program.account.collateralVault.fetch(vaultPda);
    assert.ok(vaultAccount.owner.equals(user.publicKey));
    assert.ok(vaultAccount.tradingAuthority.equals(tradingAuthority.publicKey));
  });

  it("Deposits 100 USDT into the vault!", async () => {
    await program.methods
      .deposit(DEPOSIT_AMOUNT)
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        userTokenAccount: userTokenAccount,
        vaultTokenAccount: vaultTokenAccountPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultAccount = await program.account.collateralVault.fetch(vaultPda);
    assert.equal(vaultAccount.availableBalance.toString(), DEPOSIT_AMOUNT.toString());
  });

  it("Withdraws 50 USDT from the vault!", async () => {
    await program.methods
      .withdraw(WITHDRAW_AMOUNT)
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        userTokenAccount: userTokenAccount,
        vaultTokenAccount: vaultTokenAccountPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const expectedVaultBalance = DEPOSIT_AMOUNT.sub(WITHDRAW_AMOUNT);
    const vaultAccount = await program.account.collateralVault.fetch(vaultPda);
    assert.equal(vaultAccount.availableBalance.toString(), expectedVaultBalance.toString());
  });

  it("Locks 25 USDT for a trade!", async () => {
    await program.methods
      .lockCollateral(LOCK_AMOUNT)
      .accounts({
        tradingAuthority: tradingAuthority.publicKey,
        owner: user.publicKey, // <-- 3. ADD THIS (to find the vault)
        vault: vaultPda,
      })
      .signers([tradingAuthority])
      .rpc();

    const vaultAccount = await program.account.collateralVault.fetch(vaultPda);
    assert.equal(vaultAccount.totalBalance.toString(), "50000000");
    assert.equal(vaultAccount.availableBalance.toString(), "25000000");
    assert.equal(vaultAccount.lockedBalance.toString(), "25000000");
  });

  it("Fails to withdraw locked collateral!", async () => {
    const withdrawAmount = new anchor.BN(30 * 10 ** 6);
    try {
      await program.methods
        .withdraw(withdrawAmount)
        .accounts({
          user: user.publicKey,
          vault: vaultPda,
          userTokenAccount: userTokenAccount,
          vaultTokenAccount: vaultTokenAccountPda,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("Transaction should have failed!");
    } catch (err) {
      expect(err.error.errorMessage).to.equal("Insufficient available balance.");
      console.log("Successfully failed to withdraw locked funds.");
    }
  });

  it("Unlocks 25 USDT after trade closes!", async () => {
    await program.methods
      .unlockCollateral(LOCK_AMOUNT)
      .accounts({
        tradingAuthority: tradingAuthority.publicKey,
        owner: user.publicKey, // <-- 3. ADD THIS (to find the vault)
        vault: vaultPda,
      })
      .signers([tradingAuthority])
      .rpc();

    const vaultAccount = await program.account.collateralVault.fetch(vaultPda);
    assert.equal(vaultAccount.totalBalance.toString(), "50000000");
    assert.equal(vaultAccount.availableBalance.toString(), "50000000");
    assert.equal(vaultAccount.lockedBalance.toString(), "0");
  });

  it("Withdraws the remaining 50 USDT!", async () => {
    await program.methods
      .withdraw(WITHDRAW_AMOUNT)
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        userTokenAccount: userTokenAccount,
        vaultTokenAccount: vaultTokenAccountPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultAccount = await program.account.collateralVault.fetch(vaultPda);
    assert.equal(vaultAccount.totalBalance.toString(), "0");
    assert.equal(vaultAccount.availableBalance.toString(), "0"); 
  });

});