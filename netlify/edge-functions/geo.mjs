// Tells the page which country the visitor is in (from their IP), so first-time visitors
// land on their own country's game. Never cached: it is per visitor.
export default (req, context) =>
  new Response(JSON.stringify({ c: (context.geo && context.geo.country && context.geo.country.code) || null }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
export const config = { path: '/api/geo' };
