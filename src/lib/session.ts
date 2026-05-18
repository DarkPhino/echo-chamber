export function getSessionId(): string {
  if (typeof window === "undefined") return "ssr";
  const KEY = "alterego_session_id";
  let s = window.localStorage.getItem(KEY);
  if (!s) {
    s = crypto.randomUUID();
    window.localStorage.setItem(KEY, s);
  }
  return s;
}