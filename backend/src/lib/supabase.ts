import { createClient } from "@supabase/supabase-js";

// Create a single, reusable Supabase client instance
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);