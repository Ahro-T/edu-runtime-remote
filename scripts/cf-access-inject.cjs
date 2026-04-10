// Monkey-patch ALL HTTP request methods to inject CF-Access headers for the vLLM host.
// Loaded via NODE_OPTIONS="--require /path/to/cf-access-inject.cjs"
const CF_ID = process.env.CF_ACCESS_CLIENT_ID || "";
const CF_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || "";
const VLLM_HOST = (() => {
  try { return new URL(process.env.VLLM_URL || "").hostname; } catch { return ""; }
})();

if (CF_ID && CF_SECRET && VLLM_HOST) {
  // 1. Patch globalThis.fetch
  const origFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init) {
    let url = "";
    if (typeof input === "string") url = input;
    else if (input instanceof URL) url = input.href;
    else if (input && typeof input === "object") url = input.url || "";
    if (url.includes(VLLM_HOST)) {
      init = Object.assign({}, init);
      const h = new Headers(init.headers || {});
      h.set("CF-Access-Client-Id", CF_ID);
      h.set("CF-Access-Client-Secret", CF_SECRET);
      init.headers = h;
    }
    return origFetch.call(this, input, init);
  };

  // 2. Patch http.request and https.request
  const http = require("node:http");
  const https = require("node:https");
  for (const mod of [http, https]) {
    const origRequest = mod.request;
    mod.request = function patchedRequest(urlOrOpts, optsOrCb, cb) {
      let opts, callback;
      if (typeof urlOrOpts === "string" || urlOrOpts instanceof URL) {
        const parsed = new URL(urlOrOpts.toString());
        if (typeof optsOrCb === "function") {
          callback = optsOrCb;
          opts = {};
        } else {
          opts = optsOrCb || {};
          callback = cb;
        }
        if (parsed.hostname === VLLM_HOST) {
          opts.headers = Object.assign({}, opts.headers, {
            "CF-Access-Client-Id": CF_ID,
            "CF-Access-Client-Secret": CF_SECRET,
          });
        }
        return origRequest.call(mod, parsed, opts, callback);
      } else {
        opts = urlOrOpts || {};
        callback = optsOrCb;
        const host = opts.hostname || opts.host || "";
        if (host === VLLM_HOST || host.includes(VLLM_HOST)) {
          opts.headers = Object.assign({}, opts.headers, {
            "CF-Access-Client-Id": CF_ID,
            "CF-Access-Client-Secret": CF_SECRET,
          });
        }
        return origRequest.call(mod, opts, callback);
      }
    };
  }

  // 3. Patch undici if available (Node 18+ built-in fetch uses it)
  try {
    const undici = require("undici");
    if (undici.request) {
      const origUndiciRequest = undici.request;
      undici.request = function patchedUndiciRequest(url, opts) {
        const urlStr = url.toString();
        if (urlStr.includes(VLLM_HOST)) {
          opts = Object.assign({}, opts);
          opts.headers = Object.assign({}, opts.headers, {
            "CF-Access-Client-Id": CF_ID,
            "CF-Access-Client-Secret": CF_SECRET,
          });
        }
        return origUndiciRequest.call(this, url, opts);
      };
    }
    if (undici.fetch) {
      const origUndiciFetch = undici.fetch;
      undici.fetch = function patchedUndiciFetch(input, init) {
        let url = typeof input === "string" ? input : input?.url || "";
        if (url.includes(VLLM_HOST)) {
          init = Object.assign({}, init);
          init.headers = Object.assign({}, init.headers, {
            "CF-Access-Client-Id": CF_ID,
            "CF-Access-Client-Secret": CF_SECRET,
          });
        }
        return origUndiciFetch.call(this, input, init);
      };
    }
  } catch (e) { /* undici not available as separate module */ }

  console.log(`[cf-access-inject] Patched fetch/http/https/undici for ${VLLM_HOST}`);
}
