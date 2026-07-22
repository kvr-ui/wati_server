export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': process.env.WEBSITE_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
