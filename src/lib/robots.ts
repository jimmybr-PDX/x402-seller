/**
 * robots.txt: keep the product and discovery pages crawlable; keep search
 * crawlers off fat public JSON and paid / paper paths.
 */
export function robotsTxt(publicUrl: string): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Allow: /rugradar",
    "Allow: /.well-known/x402",
    "Allow: /skill.md",
    "Allow: /agents.md",
    "Disallow: /report",
    "Disallow: /read",
    "Disallow: /check",
    "Disallow: /news",
    "Disallow: /price",
    "Disallow: /solana-price",
    "Disallow: /balance",
    "Disallow: /tx",
    "Disallow: /gas",
    "Disallow: /token",
    "Disallow: /search",
    "Disallow: /rug-check",
    "Disallow: /token-safety",
    "Disallow: /honeypot-check",
    "Disallow: /credits/",
    "Disallow: /mcp",
    "Disallow: /rugradar/api/",
    "Disallow: /stats",
    "Disallow: /openapi.json",
    "Disallow: /paper",
    `Sitemap: ${publicUrl}/sitemap.xml`,
    "",
  ].join("\n");
}
