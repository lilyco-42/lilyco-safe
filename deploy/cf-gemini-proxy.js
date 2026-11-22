// Cloudflare Worker: Zero-dependency Google AI Studio & OpenRouter Reverse Proxy
// Deploy to Cloudflare Workers and bind a custom route (e.g. https://gemini-proxy.lain42.top)
// Then set channel Base URL in Lilyco AI Studio to: https://gemini-proxy.lain42.top/v1beta/openai

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, "https://generativelanguage.googleapis.com");
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("cf-connecting-ip");
    headers.delete("cf-ipcountry");
    headers.delete("cf-ray");
    headers.delete("cf-visitor");

    const resp = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    });

    const outHeaders = new Headers(resp.headers);
    outHeaders.set("Access-Control-Allow-Origin", "*");
    outHeaders.set("X-Accel-Buffering", "no");
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: outHeaders,
    });
  },
};
