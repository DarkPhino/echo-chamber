import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// SSR-safe Supabase wrapper. supabase-js touches `localStorage` / `navigator`
// internally during client construction, which crashes the TanStack Start SSR
// runtime. We lazily instantiate the client only in the browser and expose a
// Proxy stub on the server so module evaluation never throws.
const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const isBrowser = typeof window !== "undefined";

let browserClient: SupabaseClient<Database> | null = null;
function getBrowserClient(): SupabaseClient<Database> {
  if (!browserClient) {
    browserClient = createClient<Database>(url, key, {
      auth: {
        storage: window.localStorage,
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }
  return browserClient;
}

const ssrStub = new Proxy(
  {},
  {
    get() {
      throw new Error("supabase client accessed during SSR");
    },
  },
) as unknown as SupabaseClient<Database>;

export const supabase: SupabaseClient<Database> = isBrowser
  ? getBrowserClient()
  : ssrStub;