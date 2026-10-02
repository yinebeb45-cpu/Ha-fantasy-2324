/**
 * Ha Fantasy — Official FPL API proxy (no key needed)
 * Deploy as: api/fpl.js on Vercel
 *
 * Examples:
 *   /api/fpl?path=/bootstrap-static/
 *   /api/fpl?path=/event/8/live/
 *   /api/fpl?path=/fixtures/
 */

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }

  let path = (req.query && req.query.path) || '/bootstrap-static/';
  path = String(path);
  if (!path.startsWith('/')) path = '/' + path;
  // Safety: only allow known FPL API prefixes
  if (!/^\/(bootstrap-static\/?|event\/\d+\/live\/?|fixtures\/?|element-summary\/\d+\/?)/.test(path)) {
    return res.status(400).json({ ok: false, error: 'path not allowed' });
  }

  const url = 'https://fantasy.premierleague.com/api' + path;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 HaFantasy/1.0',
        Accept: 'application/json'
      }
    });
    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: 'FPL upstream ' + response.status
      });
    }
    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json(data);
  } catch (e) {
    console.error('FPL proxy error', e);
    return res.status(500).json({ ok: false, error: e.message || 'proxy failed' });
  }
};
'''

from pathlib import Path
# file already written by tool
print('ok')
