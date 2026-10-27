/**
 * Token name / ticker for report headers, share text and Recent entries. Token names are attacker-controlled, so every
 * name or symbol is sanitized before it is stored or shown: control/invisible characters, links (URLs and bare domains),
 * @mentions, #hashtags, $cashtag marks and angle brackets are removed, whitespace is collapsed and the text is cut to
 * 32 characters (symbols 20). One JS source (CLEAN_JS) runs on the server and in the page, so both behave identically
 * (the page also cleans older saved reports that were stored before this existed).
 */
export const CLEAN_JS = String.raw`function rrClean(s,m){if(typeof s!=='string')return '';m=m||32;
s=s.normalize('NFKC').replace(/[\u3002\uff61\u2024\ufe52]/g,'.').replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffc]/g,'').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,' ');
s=s.replace(/\b(?:https?|ftp|ipfs|data|javascript|tg|mailto):\S*/gi,' ').replace(/\/\/\S+/g,' ').replace(/\bwww\.\S*/gi,' ').replace(/[^\s@.]+(?:\.[^\s@.]+)*\.[a-z]{2,}\b(?:[\/:?#]\S*)?/gi,' ').replace(/[@\uff20]\S*/g,' ').replace(/[@#$<>\u0060\\]/g,' ');
s=Array.from(s.replace(/\s+/g,' ').trim()).slice(0,m).join('').trim();return s}
const RR_IMG_HOSTS=['cdn.dexscreener.com','static.jup.ag','img-cdn.jup.ag'];
function rrImg(u){if(typeof u!=='string'||u.length>400)return '';try{const x=new URL(u);if(x.protocol!=='https:'||x.username||x.password||x.port||RR_IMG_HOSTS.indexOf(x.hostname)<0)return '';if(x.hostname==='cdn.dexscreener.com'){x.searchParams.set('width','96');x.searchParams.set('height','96')}return x.href}catch(e){return ''}}
function rrTok(f){f=f||{};const s=rrClean(f.tokenSymbol||f.token||'',20),n=rrClean(f.tokenName||'',32),line=n&&s&&n.toLowerCase()!==s.toLowerCase()?n+' \u00b7 $'+s:(s?'$'+s:n);return {s:s,n:n,line:line,share:s&&!/\s/.test(s)?'$'+s:(n||s),img:rrImg(f.tokenImage)}}
`;
const fns = new Function(CLEAN_JS + "; return {rrClean,rrImg};")() as { rrClean: (s: unknown, m?: number) => string; rrImg: (u: unknown) => string };
/** Sanitized text, "" when nothing safe is left. */
export const cleanTokenText = (s: unknown, max = 32): string => fns.rrClean(s as string, max);
/** Image URL only from known token-image CDNs over https, else "". */
export const safeTokenImage = (u: unknown): string => fns.rrImg(u as string);
export type TokenMeta = { tokenName: string | null; tokenSymbol: string | null; tokenImage: string | null };
/** First usable name / symbol / image across sources, in priority order. Nothing usable -> all null. */
export function pickTokenMeta(cands: { name?: unknown; symbol?: unknown; image?: unknown }[]): TokenMeta {
  let tokenName: string | null = null, tokenSymbol: string | null = null, tokenImage: string | null = null;
  for (const c of cands) {
    if (!c) continue;
    tokenName ??= cleanTokenText(c.name, 32) || null;
    tokenSymbol ??= cleanTokenText(c.symbol, 20) || null;
    tokenImage ??= safeTokenImage(c.image) || null;
  }
  return { tokenName, tokenSymbol, tokenImage };
}
