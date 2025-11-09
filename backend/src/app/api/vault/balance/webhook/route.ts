import { NextResponse, NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";
import { AnchorProvider, Program, Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { CollateralVault } from "@/lib/idl";
// import { CollateralVault } from "@/lib/idl"; 

// Your Program ID
const PROGRAM_ID = new PublicKey("2EMRqcZ82SxuQ7QLEBuF16ppB12UscSHxjsa9muKDa1R");

// This is the main function that Helius will call
export async function POST(request: NextRequest) {
  try {
    const data = await request.json();

    // Helius sends an array of transactions, we'll process the first one
    const tx = data[0];

    // 1. Check if it's a successful transaction from our program
    if (
      tx.type === "ENHANCED" &&
      tx.accountData[0]?.programId === PROGRAM_ID.toBase58()
    ) {
      // Use Anchor to parse the event data
      const event = parseHeliusEvent(tx);
      if (!event) {
        return NextResponse.json({ message: "Event not relevant" });
      }

      // --- 2. Handle the Event ---

      // A. If it's a DepositEvent, update the vault
      if (event.name === "DepositEvent") {
        await handleDepositEvent(event.data, tx.signature);
      }

      // B. If it's an InitializeVault instruction, create the vault
      if (event.name === "InitializeVault") {
        await handleInitializeVault(tx);
      }
    }

    // 3. Respond to Helius
    return NextResponse.json({ message: "Webhook processed" });

  } catch (e) {
    console.error("Error processing webhook:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// --- Helper Functions ---

async function handleDepositEvent(eventData: any, signature: string) {
  const userPubkey = (eventData.user as PublicKey).toBase58();
  const newBalance = BigInt(eventData.newBalance as string);
  const amount = BigInt(eventData.amount as string);

  // Find the vault using the user's pubkey
  const { data: vault, error } = await supabase
    .from("vaults")
    .select("vault_pda, total_balance, available_balance")
    .eq("owner_pubkey", userPubkey)
    .single();

  if (error || !vault) {
    throw new Error(`Vault not found for user ${userPubkey}`);
  }

  // 1. Update the vault balance
  await supabase
    .from("vaults")
    .update({
      total_balance: newBalance,
      // We assume deposit only affects available balance
      available_balance: BigInt(vault.available_balance) + amount,
    })
    .eq("owner_pubkey", userPubkey);

  // 2. Insert into transaction history
  await supabase.from("transactions").insert({
    vault_pda: vault.vault_pda,
    signature: signature,
    transaction_type: "deposit",
    amount: amount,
  });
    
  console.log(`Updated deposit for ${userPubkey}. New balance: ${newBalance}`);
}

async function handleInitializeVault(tx: any) {
  // Get all the accounts from the instruction
  const accounts = tx.instructions[0].accounts;
  
  const userPubkey = accounts[0]; // user
  const tradingAuthority = accounts[1]; // trading_authority
  const vaultPda = accounts[2]; // vault
  const vaultTokenAccount = accounts[3]; // vault_token_account
  
  // Insert the new vault into our database
  await supabase.from("vaults").insert({
    owner_pubkey: userPubkey,
    vault_pda: vaultPda,
    token_account_pda: vaultTokenAccount,
    trading_authority: tradingAuthority,
    total_balance: 0,
    locked_balance: 0,
    available_balance: 0,
  });

  console.log(`New vault initialized: ${vaultPda}`);
}


// --- Anchor/Helius Parser ---
// This boilerplate code is needed to read the event data
// ...
const connection = new Connection(
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
);
const provider = new AnchorProvider(connection, {} as any, {});

// --- FIXES ---
// 1. Swapped `provider` and `PROGRAM_ID` to the correct order.
// 2. Used `as unknown as Idl` to fix the "readonly" error.
const program = new Program(CollateralVault as unknown as Idl, provider, PROGRAM_ID);
//

function parseHeliusEvent(tx: any) {
  // 1. Find the `logMessage` event from the inner instructions
  const log = tx.events.find((e: any) => e.type === "anchor");
  if (!log || !log.data) {
    // If it's not a log message, check for InitializeVault instruction
    if (tx.instructions[0]?.name === "initializeVault") {
      return { name: "InitializeVault", data: null };
    }
    return null;
  }
  
  // 2. Parse the event data using Anchor's parser
  const eventData = program.coder.events.decode(log.data);
  return eventData;
}