import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase configuration. Ensure SUPABASE_URL and SUPABASE_ANON_KEY are set in .env");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);