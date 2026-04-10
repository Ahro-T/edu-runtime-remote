// HTTPS reverse proxy that intercepts requests to the vLLM host via /etc/hosts hijack.
// Adds CF-Access headers and forwards to the real upstream.
// Self-signed cert is generated at startup.
import { createServer } from "node:https";
import { request as httpsRequest } from "node:https";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const VLLM_HOST = (() => {
  try { return new URL(process.env.VLLM_URL || "").hostname; } catch { return "llm.agentic-ai-gist.org"; }
})();
const CF_ID = process.env.CF_ACCESS_CLIENT_ID || "";
const CF_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || "";
// Real IP of the vLLM host (resolved before /etc/hosts hijack)
const REAL_IP = process.env.VLLM_REAL_IP || "";
const PORT = parseInt(process.env.PROXY_PORT || "443", 10);

// Generate self-signed cert
execSync(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout /tmp/proxy-key.pem -out /tmp/proxy-cert.pem -days 1 -subj "/CN=${VLLM_HOST}" 2>/dev/null`);

const server = createServer({
  key: readFileSync("/tmp/proxy-key.pem"),
  cert: readFileSync("/tmp/proxy-cert.pem"),
}, (req, res) => {
  const headers = { ...req.headers, host: VLLM_HOST };
  if (CF_ID)     headers["cf-access-client-id"] = CF_ID;
  if (CF_SECRET) headers["cf-access-client-secret"] = CF_SECRET;

  const opts = {
    hostname: REAL_IP,
    port: 443,
    path: req.url,
    method: req.method,
    headers,
    servername: VLLM_HOST, // SNI
  };

  const proxy = httpsRequest(opts, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  proxy.on("error", (e) => {
    console.error(`[vllm-proxy] error: ${e.message}`);
    res.writeHead(502); res.end("Bad Gateway");
  });
  req.pipe(proxy);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[vllm-proxy] HTTPS reverse proxy on :${PORT} for ${VLLM_HOST} → ${REAL_IP} (CF-Access: ${CF_ID ? "enabled" : "disabled"})`);
});
