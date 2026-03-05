# mp4-and-hls-source-proxy

Multi-runtime HTTP proxy for MP4 and HLS (M3U8) streams, designed to sit in front of third‑party CDNs and expose a stable, CORS‑friendly API.

This code mirrors the behavior of a Cloudflare Worker used in the main project, but is packaged for:

- **Deno** (standalone server, Deno Deploy friendly)
- **Node.js** (normal Node HTTP server)
- **Vercel** (serverless function)

All runtimes share the same request format and `sourceid` encoding, so the same client code can talk to any of them.

## Features

- **M3U8 proxy** that rewrites inner URLs to go back through the proxy
  - `GET /m3u8-proxy?url=<encoded>&headers=<encodedJson>`
- **TS segment proxy** for HLS segments
  - `GET /ts-segment?url=<encoded>&headers=<encodedJson>`
- **MP4 proxy** with `Range` support for seeking
  - `GET /mp4-proxy?url=<encoded>&headers=<encodedJson>`
- **Generic fetch proxy**
  - `GET /fetch?url=<encoded>&headers=<encodedJson>`
- **`sourceid` format** used by the main API:
  - `sourceid = btoa("url=" + encodeURIComponent(url) + "&headers=" + encodeURIComponent(JSON.stringify(headers)))`
  - Runtime endpoints:
    - `GET /hls/:sourceid` → proxied M3U8, inner URLs rewritten to `/hls/:sourceid` and `/ts/:sourceid`
    - `GET /ts/:sourceid` → proxied TS segment
    - `GET /mp4/:sourceid` → proxied MP4 with Range

All Runtimes normalize URLs with multiple `?` characters in the query string and forward common headers (`User-Agent`, `Accept`, etc.) to behave like a normal browser.

## Layout

- `dono/deno-proxy.ts` – Deno HTTP server (`Deno.serve`)
- `dono/deno.json` – simple task file (`deno task serve`)
- `node/normal-proxy.ts` – plain Node.js HTTP proxy (Node 18+)
- `node/package.json` – Node project config
- `vercel/vercel-proxy.ts` – Vercel function handler (TypeScript, `@vercel/node`)
- `vercel/vercel.json` – Vercel config; routes at root (`/m3u8-proxy`, `/hls/:sourceid`, etc.)

If you want to use this repository standalone (as in `https://github.com/basirulakhlakborno/mp4-and-hls-source-proxy`), place the runtime file you care about (`deno-proxy.ts`, `normal-proxy.ts`, or `vercel-proxy.ts`) at the repository root together with this `README.md` and `LICENSE`.

## Deno usage

```bash
cd dono
deno task serve
# or
deno run --allow-net deno-proxy.ts
```

This will start a server (by default on `0.0.0.0:8000` for Deno Deploy, or whatever port Deno chooses locally).

Example:

```bash
curl "http://localhost:8000/m3u8-proxy?url=$(python - <<EOF
import urllib.parse
print(urllib.parse.quote('https://example.com/playlist.m3u8', safe=''))
EOF
)"
```

## Node.js usage

```bash
cd node
npm install  # only needed if you add deps
npm start    # runs: node normal-proxy.ts
```

The server defaults to `http://localhost:8788`.

Example:

```bash
curl "http://localhost:8788/mp4-proxy?url=$(node -e \"console.log(encodeURIComponent('https://example.com/video.mp4'))\")"
```

## Vercel usage

In a Vercel project, put:

- `vercel/vercel-proxy.ts`
- `vercel/vercel.json`

at the project root (or adjust paths), then deploy. The function will be exposed at the root:

- `GET /m3u8-proxy?url=...&headers=...`
- `GET /mp4-proxy?url=...&headers=...`
- `GET /ts-segment?url=...&headers=...`
- `GET /fetch?url=...&headers=...`
- `GET /hls/:sourceid`, `GET /ts/:sourceid`, `GET /mp4/:sourceid`

## License

This project is licensed under the **MIT License**. See `LICENSE` for details.

