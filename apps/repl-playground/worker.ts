/** Serves the playground build (base `/playground/`) from Worker Static Assets. */

interface StaticAssetsEnv {
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: StaticAssetsEnv): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/')
      return Response.redirect(new URL('/playground/', url).href, 302)
    if (url.pathname !== '/playground' && !url.pathname.startsWith('/playground/'))
      return new Response('Not found', { status: 404 })
    if (url.pathname === '/playground' || url.pathname === '/playground/') {
      url.pathname = '/index.html'
      return env.ASSETS.fetch(new Request(url.href, request))
    }
    url.pathname = url.pathname.slice('/playground'.length)
    const asset = await env.ASSETS.fetch(new Request(url.href, request))
    // SPA fallback: extensionless routes (such as the OAuth callback) load the app.
    if (asset.status === 404 && request.method === 'GET') {
      url.pathname = '/index.html'
      return env.ASSETS.fetch(new Request(url.href, request))
    }
    return asset
  },
}
