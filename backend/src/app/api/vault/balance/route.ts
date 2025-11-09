import { NextResponse, NextRequest } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = 'force-dynamic'; // Still good to keep this

export async function GET(request: NextRequest) {
  // Get the user's pubkey from the query parameters
  const userPubkey = request.nextUrl.searchParams.get("user");

  if (!userPubkey) {
    return NextResponse.json({ error: "User pubkey is required" }, { status: 400 });
  }

  try {
    // Fetch the vault data from Supabase
    const { data, error } = await supabase
      .from("vaults")
      .select("*")
      .eq("owner_pubkey", userPubkey)
      .single(); // .single() picks the one matching row

    if (error) {
      console.error("Supabase error:", error.message);
      // This error often means "no vault found"
      return NextResponse.json({ error: "Vault not found" }, { status: 404 });
    }

    // Return the vault data
    return NextResponse.json(data);
    
  } catch (e) {
    console.error("Internal server error:", e);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}