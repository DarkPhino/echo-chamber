import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// SSR-safe Supabase wrapper. The auto-generated client at
// `@/integrations/supabase/client` references `localStorage` at module init,
// which crashes the TanStack Start SSR runtime. Routes should import the
// supabase client from THIS file instead so the storage option is only read
// when running in the browser.
const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
const isBrowser = typeof window !== "undefined";

export const supabase = createClient<Database>(url, key, {
  auth: {
    storage: isBrowser ? window.localStorage : undefined,
    persistSession: isBrowser,
    autoRefreshToken: isBrowser,
  },
});