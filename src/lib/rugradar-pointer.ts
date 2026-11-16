/**
 * Free "Check this token on RugRadar" pointer for high-view public tool pages
 * (/report, /search, /balance, /watch): HTML paywall line plus an optional see_also
 * field on JSON/402 bodies. Never touches accepts or payment fields.
 */
export const RUGRADAR_POINTER_LABEL = "Check this token on RugRadar";
export const RUGRADAR_PATH = "/rugradar";
const defaultBase = () => (process.env.PUBLIC_URL ?? "https://x402-seller-pmlm.onrender.com").replace(/\/+$/, "");

/** Browser paywall pages that get a visible RugRadar link. */
export const POINTER_PATHS = new Set(["/report", "/search", "/balance", "/watch"]);

/** Paid JSON/402 responses that may include an optional see_also hint. */
export const SEE_ALSO_PATHS = new Set([
  "/report", "/read", "/check", "/news", "/price", "/solana-price",
  "/balance", "/tx", "/gas", "/search", "/watch",
]);

/** Same check RugRadar's landing page uses before auto-filling ?token=. */
export function looksLikeToken(raw: string): boolean {
  const t = raw.trim();
  return t.length >= 20 && t.length <= 64 && /^[A-Za-z0-9]+$/.test(t);
}

export function queryValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return v == null ? "" : String(v).trim();
}

export function queryFromUnpaidContext(
  ctx: { adapter?: { getQueryParam?: (name: string) => string | string[] | undefined } } | undefined,
  name: string,
): string {
  return queryValue(ctx?.adapter?.getQueryParam?.(name));
}

export function tokenFromQuery(path: string, get: (name: string) => string): string {
  const pick = (...names: string[]) => {
    for (const n of names) {
      const v = (get(n) ?? "").trim();
      if (v) return v;
    }
    return "";
  };
  if (path === "/watch") return pick("token", "mint");
  if (path === "/balance") return pick("address", "token");
  const q = pick("token", "q");
  return looksLikeToken(q) ? q : "";
}

export function rugradarHref(token = "", base = defaultBase()): string {
  const root = `${String(base).replace(/\/llms\.txt$/, "").replace(/\/$/, "")}${RUGRADAR_PATH}`;
  const t = token.trim();
  if (looksLikeToken(t)) return `${root}?token=${encodeURIComponent(t)}`;
  return root;
}

export function seeAlsoLine(token = "", base = defaultBase()): string {
  return `${RUGRADAR_POINTER_LABEL}: ${rugradarHref(token, base)}`;
}

/** Add see_also only when the body is a plain object and the field is not already set. */
export const withSeeAlso = <T,>(out: T, token = "", base = defaultBase()): T =>
  (out && typeof out === "object" && !Array.isArray(out) && !("see_also" in (out as object))
    ? { ...(out as object), see_also: seeAlsoLine(token, base) } as T
    : out);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** One-line HTML pointer (e.g. /a permalink footer). */
export function pointerHtmlLine(base = defaultBase(), token = ""): string {
  const href = rugradarHref(token, base);
  return `<small><a href="${esc(href)}">${esc(RUGRADAR_POINTER_LABEL)}</a></small>`;
}

/**
 * Browser 402 paywall for the four tool pages. Keeps the default x402 layout and
 * adds one RugRadar link. A tiny script attaches ?token= from token/address/mint
 * when the current URL already has one (RugRadar already accepts that param).
 */
export function pointerPaywallHtml(toolName: string, priceNote?: string): string {
  const price = priceNote ? ` (${esc(priceNote)})` : "";
  return `<!DOCTYPE html>
<html>
  <head>
    <title>Payment Required</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body>
    <div style="max-width: 600px; margin: 50px auto; padding: 20px; font-family: system-ui, -apple-system, sans-serif;">
      <h1>Payment Required</h1>
      <p>${esc(toolName)} is protected by the x402 payment protocol${price}.</p>
      <p><a id="rugradar-pointer" href="/rugradar">${RUGRADAR_POINTER_LABEL}</a></p>
      <p style="margin-top: 2rem; padding: 1rem; background: #fef3c7; border-radius: 0.5rem;">
        <strong>Note to developers:</strong> install <code>@x402/paywall</code> to enable
        the in-browser wallet connection and payment UI. Programmatic clients should read
        the payment requirements from the 402 response headers and JSON body.
      </p>
    </div>
    <script>
    (function(){try{var u=new URLSearchParams(location.search),t=u.get("token")||u.get("address")||u.get("mint");
    if(t&&/^[A-Za-z0-9]{20,64}$/.test(t)){var a=document.getElementById("rugradar-pointer");if(a)a.href="/rugradar?token="+encodeURIComponent(t);}
    }catch(e){}})();
    </script>
  </body>
</html>`;
}
