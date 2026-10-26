/**
 * Client script for the paid (unlocked) report blocks. Served separately at /rugradar/live.js and loaded only after a
 * paid check returns `liveReport`, so the free page stays small. Builds DOM with textContent only; every block hides
 * itself when its data is missing. Factual status and danger warnings only: no advice, no wallet names.
 */
export const LIVE_CSS = `.lv{margin-top:12px;display:grid;gap:12px}.lb{border:1px solid var(--line);border-radius:12px;background:#0F1628;padding:12px}.lb h3{margin:0 0 8px;font-size:15px}.lb h3 small{font-weight:400;color:var(--mut);font-size:12px;margin-left:6px}
.lchart{width:100%;height:340px;border:0;border-radius:8px;background:#0b1020;display:block}@media(max-width:899px){.lchart{height:300px}}
.wr{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:7px 10px;margin:5px 0;border-radius:8px;font-size:14px;border-left:4px solid}.wr.h{border-color:#22C55E;background:rgba(34,197,94,.10)}.wr.u{border-color:#64748b;background:rgba(100,116,139,.10)}.wr.u .tg{background:#334155;color:#cbd5e1}.wr.s{border-color:var(--bad);background:rgba(239,68,68,.12)}
.wr a{color:var(--tx);font-family:ui-monospace,Menlo,monospace;font-size:13px}.wr span{white-space:nowrap}.wr .tg{font-size:11px;font-weight:900;border-radius:5px;padding:2px 6px;margin-left:6px}.wr.h .tg{background:#22C55E;color:#04150a}.wr.s .tg{background:var(--bad);color:#fff}.wr .kd{font-size:11px;color:var(--mut);margin-left:6px}
.lsum{font-size:13px;color:#c9d1e0;margin:0 0 6px}.l2{display:grid;gap:12px}@media(min-width:700px){.l2{grid-template-columns:1fr 1fr}}
.tr{display:flex;justify-content:space-between;gap:8px;font-size:14px;padding:4px 0;border-bottom:1px solid var(--line)}.tr:last-child{border:0}.tr i{font-style:normal;color:var(--mut);font-size:12px}
.rk{display:grid;grid-template-columns:1fr auto;gap:4px 10px;font-size:14px}.rk b{text-align:right}.rk .bad{color:#ff8a8a}.rk .ok{color:#6CFFA0}.lnote{font-size:11px;color:var(--mut);margin-top:6px}.lhd{font-size:12px;color:var(--mut);text-align:center;letter-spacing:.04em;padding:5px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.lend{border-top:0;padding-top:0}`;
export const LIVE_JS = String.raw`(function(){
var B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function sh(a){a=String(a||'');return a.length>14?a.slice(0,4)+'\u2026'+a.slice(-4):a}
function ago(t){var s=Math.max(0,(Date.now()-Date.parse(t))/1000);if(!isFinite(s))return '';return s<90?Math.round(s)+'s ago':s<5400?Math.round(s/60)+'m ago':s<172800?Math.round(s/3600)+'h ago':Math.round(s/86400)+'d ago'}
function usd(n){return n==null?'':n>=1000?'$'+(n/1000).toFixed(1).replace(/\.0$/,'')+'k':'$'+(n>=10?Math.round(n):n.toFixed(2))}
function pc(n){return n==null?'?':(n<0.01&&n>0?'<0.01':n.toFixed(n<10?2:1).replace(/\.?0+$/,'')||'0')+'%'}
function blk(title,sub){var b=el('div','lb'),h=el('h3',null,title);if(sub)h.append(el('small',null,sub));b.append(h);return b}
function row(w,kind){if(!w||!B58.test(String(w.address)))return null;var unk=w.status==='unknown',sold=w.status==='sold',r=el('div','wr '+(sold?'s':unk?'u':'h')),a=el('a',null,sh(w.address));a.href='https://solscan.io/account/'+w.address;a.target='_blank';a.rel='noopener noreferrer nofollow';
 var l=el('span');l.append(a);if(kind&&w.tags&&w.tags.length)l.append(el('span','kd',w.tags.join('/')));
 var r2=el('span',null,unk?'':sold?(w.holdingPct?pc(w.holdingPct)+' left':''):pc(w.holdingPct)+' of supply');r2.append(el('span','tg',sold?'Sold':unk?'Status unavailable':'Holding'));r.append(l,r2);return r}
function fills(title,xs){if(!Array.isArray(xs)||!xs.length)return null;var b=blk(title);xs.forEach(function(f){var t=el('div','tr'),v=f.usd!=null?usd(f.usd):'',s=f.sol!=null?f.sol+' SOL':'';t.append(el('span',null,[s,v&&s?'('+v+')':v].filter(Boolean).join(' ')),el('i',null,ago(f.at)));b.append(t)});return b}
window.RRLive=function(j){var L=j&&j.liveReport;if(!L)return null;var box=el('div','lv'),n=0;
 try{if(!document.getElementById('lvcss')){var s=el('style',null,${JSON.stringify(LIVE_CSS)});s.id='lvcss';document.head.append(s)}}catch(e){}
 var c=L.chart&&typeof L.chart.embedUrl==='string'&&/^https:\/\/www\.geckoterminal\.com\/solana\/pools\/[1-9A-HJ-NP-Za-km-z]{32,44}\?/.test(L.chart.embedUrl)?L.chart.embedUrl:null;
 if(c){var b=blk('Live price chart','1-minute');var f=el('iframe','lchart');f.loading='lazy';f.src=c;f.title='Live 1-minute price chart';f.referrerPolicy='no-referrer';f.setAttribute('sandbox','allow-scripts allow-same-origin allow-popups');b.append(f);box.append(b);n++}
 if(Array.isArray(L.devWallets)&&L.devWallets.length){var d=blk('Dev wallet','creator');L.devWallets.forEach(function(w){var r=row(w);if(r)d.append(r)});if(d.children.length>1){box.append(d);n++}}
 var S=L.sniperBundle;if(S&&Array.isArray(S.shown)&&S.shown.length){var sb=blk('Sniper / bundle wallets',S.count+' total');
  sb.append(el('p','lsum','Held '+pc(S.startPct)+' of supply at the start \u00b7 hold '+pc(S.nowPct)+' now \u00b7 '+S.stillHolding+' of '+S.count+' still holding'));
  S.shown.forEach(function(w){var r=row(w,1);if(r)sb.append(r)});if(S.count>S.shown.length)sb.append(el('div','lnote','Top '+S.shown.length+' by size shown.'));box.append(sb);n++}
 if(!(S&&Array.isArray(S.shown)&&S.shown.length)){var nb=blk('Sniper / bundle wallets');nb.append(el('div','lnote','Early-buyer wallets could not be read for this token (its launch trades were not captured).'));box.append(nb);n++}
 var bs=el('div','l2'),bb=fills('Top 5 biggest buys',L.biggestBuys),sl=fills('Top 5 biggest sells',L.biggestSells);if(bb)bs.append(bb);if(sl)bs.append(sl);if(bb||sl){box.append(bs);if(L.tradesBasis)bs.append(el('div','lnote','From the '+L.tradesBasis+'.'));n++}
 var R=L.risk;if(R){var rk=blk('Risk checks'),g=el('div','rk');
  var add=function(k,v,cls){g.append(el('span',null,k),el('b',cls||'',v))};
  add('Can you sell?',R.canSell==='yes'?'Yes'+(R.canSellVia?' ('+R.canSellVia+')':''):R.canSell==='no'?'No sell route found':'Unknown',R.canSell==='yes'?'ok':R.canSell==='no'?'bad':'');
  if(R.sellImpactPct!=null)add('Selling ~$100 moves price',pc(R.sellImpactPct),R.sellImpactPct>20?'bad':'');
  if(R.taxPct!=null)add('Buy/sell tax',R.taxPct>0?pc(R.taxPct):'None found',R.taxPct>=10?'bad':R.taxPct>0?'':'ok');
  add('Mint authority',R.mintAuthority==='off'?'Off':R.mintAuthority==='on'?'On':'Unknown',R.mintAuthority==='off'?'ok':R.mintAuthority==='on'?'bad':'');
  add('Freeze authority',R.freezeAuthority==='off'?'Off':R.freezeAuthority==='on'?'On':'Unknown',R.freezeAuthority==='off'?'ok':R.freezeAuthority==='on'?'bad':'');
  if(R.top10Pct!=null)add('Top 10 holders',pc(R.top10Pct),R.top10Pct>70?'bad':'');
  rk.append(g,el('div','lnote','May include pool/curve accounts. Danger warnings only. Not financial advice.'));box.append(rk);n++}
 if(!n)return null;var N=Array.isArray(j.checks)?j.checks.length:0;box.prepend(el('div','lhd','Full report \u00b7 unlocked'));box.append(el('div','lhd lend','End of report'+(N?' \u00b7 '+N+' checks run':'')));return box};
})();`;
