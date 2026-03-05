// Normal Node.js proxy server compatible with the Worker/Deno/Vercel proxy format.
// Run with:
//   node normal-proxy.ts   (Node 18+ for global fetch), or
//   ts-node normal-proxy.ts

import http from 'http';
import { URL } from 'url';

const DEFAULT_FETCH_HEADERS: Record<string, string> = {
	'User-Agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	Accept: '*/*',
	'Accept-Language': '*',
	'Accept-Encoding': 'gzip, deflate, br',
};

function normalizeTargetUrl(url: string): string {
	const qIdx = url.indexOf('?');
	let normalized = url;
	if (qIdx !== -1) {
		normalized = url.slice(0, qIdx + 1) + url.slice(qIdx + 1).replace(/\?/g, '&');
	}
	return normalized;
}

function json(res: http.ServerResponse, status: number, data: unknown) {
	const body = JSON.stringify(data, null, 2);
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json');
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.end(body);
}

function parseHeadersParam(raw?: string | string[]): Record<string, string> {
	if (!raw) return {};
	const str = Array.isArray(raw) ? raw[0] : raw;
	const custom: Record<string, string> = {};
	try {
		const parsed = JSON.parse(decodeURIComponent(str));
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value !== 'string') continue;
			const normalizedKey = key.toLowerCase();
			if (normalizedKey === 'origin') {
				custom['Origin'] = value;
			} else if (normalizedKey === 'referer' || normalizedKey === 'referrer') {
				custom['Referer'] = value;
			} else {
				custom[key] = value;
			}
		}
	} catch {
		// ignore
	}
	return custom;
}

function decodeSourceId(
	sourceid: string
): { url: string; headers: Record<string, string> } | null {
	try {
		const decoded = Buffer.from(sourceid, 'base64').toString('utf8');
		const params = new URLSearchParams(decoded);
		const urlParam = params.get('url');
		const headersParam = params.get('headers');
		if (!urlParam) return null;
		let headers: Record<string, string> = {};
		if (headersParam) {
			try {
				headers = JSON.parse(decodeURIComponent(headersParam));
			} catch {
				// ignore
			}
		}
		return { url: decodeURIComponent(urlParam), headers };
	} catch {
		return null;
	}
}

async function proxyFetch(
	targetUrl: string,
	customHeaders: Record<string, string>,
	init: RequestInit = {}
) {
	const url = normalizeTargetUrl(targetUrl);
	return fetch(url, {
		...init,
		headers: { ...DEFAULT_FETCH_HEADERS, ...customHeaders },
	});
}

async function handleM3u8Proxy(reqUrl: URL, res: http.ServerResponse) {
	const encodedUrl = reqUrl.searchParams.get('url');
	const headersParam = reqUrl.searchParams.get('headers') ?? undefined;
	if (!encodedUrl) return json(res, 400, { error: 'Missing url parameter' });

	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(encodedUrl));
	} catch {
		targetUrl = normalizeTargetUrl(encodedUrl);
	}

	const customHeaders = parseHeadersParam(headersParam);
	const upstream = await proxyFetch(targetUrl, customHeaders);
	if (!upstream.ok) {
		res.statusCode = upstream.status;
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.end(await upstream.text());
		return;
	}

	const text = await upstream.text();
	const serverOrigin = `${reqUrl.protocol}//${reqUrl.host}`;
	const encodedHeaders = headersParam ? encodeURIComponent(headersParam) : '';

	const proxified = text
		.split('\n')
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#EXT')) {
				if (trimmed.includes('URI="')) {
					return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
						const absoluteUrl = new URL(uri, targetUrl).href;
						const encUrl = encodeURIComponent(absoluteUrl);
						const isPlaylist =
							absoluteUrl.includes('.m3u') || absoluteUrl.includes('playlist');
						const proxiedUrl = isPlaylist
							? `${serverOrigin}/m3u8-proxy?url=${encUrl}${
									encodedHeaders ? `&headers=${encodedHeaders}` : ''
								}`
							: `${serverOrigin}/fetch?url=${encUrl}${
									encodedHeaders ? `&headers=${encodedHeaders}` : ''
								}`;
						return `URI="${proxiedUrl}"`;
					});
				}
				return line;
			}

			const absoluteUrl = new URL(trimmed, targetUrl).href;
			const encUrl = encodeURIComponent(absoluteUrl);
			const isPlaylist = absoluteUrl.includes('.m3u') || absoluteUrl.includes('playlist');
			if (isPlaylist) {
				return `${serverOrigin}/m3u8-proxy?url=${encUrl}${
					encodedHeaders ? `&headers=${encodedHeaders}` : ''
				}`;
			}
			return `${serverOrigin}/ts-segment?url=${encUrl}${
				encodedHeaders ? `&headers=${encodedHeaders}` : ''
			}`;
		})
		.join('\n');

	res.statusCode = 200;
	res.setHeader(
		'Content-Type',
		upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl'
	);
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.end(proxified);
}

async function handleTSSegment(reqUrl: URL, res: http.ServerResponse) {
	const encodedUrl = reqUrl.searchParams.get('url');
	const headersParam = reqUrl.searchParams.get('headers') ?? undefined;
	if (!encodedUrl) return json(res, 400, { error: 'Missing url parameter' });

	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(encodedUrl));
	} catch {
		targetUrl = normalizeTargetUrl(encodedUrl);
	}
	const customHeaders = parseHeadersParam(headersParam);
	const upstream = await proxyFetch(targetUrl, customHeaders);

	if (!upstream.ok) {
		res.statusCode = upstream.status;
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.end(await upstream.text());
		return;
	}

	res.statusCode = 200;
	res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/MP2T');
	res.setHeader('Access-Control-Allow-Origin', '*');
	upstream.body?.pipeTo(
		new WritableStream({
			write(chunk) {
				res.write(chunk);
			},
			close() {
				res.end();
			},
		})
	);
}

async function handleMP4Proxy(req: http.IncomingMessage, reqUrl: URL, res: http.ServerResponse) {
	const encodedUrl = reqUrl.searchParams.get('url');
	const headersParam = reqUrl.searchParams.get('headers') ?? undefined;
	if (!encodedUrl) return json(res, 400, { error: 'Missing url parameter' });

	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(encodedUrl));
	} catch {
		targetUrl = normalizeTargetUrl(encodedUrl);
	}

	const customHeaders = parseHeadersParam(headersParam);
	const clientRange = req.headers['range'] as string | undefined;
	if (clientRange) customHeaders['Range'] = clientRange;

	const upstream = await proxyFetch(targetUrl, customHeaders);
	const status = upstream.status;

	if (status >= 400) {
		const errorText = await upstream.text().catch(() => 'Upstream error');
		return json(res, status, { error: 'Upstream error', status, message: errorText });
	}

	const finalStatus =
		status === 206 || (clientRange && status === 200) ? 206 : status;
	const headers: Record<string, string> = {
		'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
		'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
	};
	const len = upstream.headers.get('content-length');
	if (len) headers['Content-Length'] = len;
	const cr = upstream.headers.get('content-range');
	if (cr) headers['Content-Range'] = cr;
	const ar = upstream.headers.get('accept-ranges');
	if (ar) headers['Accept-Ranges'] = ar;

	res.statusCode = finalStatus;
	for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

	upstream.body?.pipeTo(
		new WritableStream({
			write(chunk) {
				res.write(chunk);
			},
			close() {
				res.end();
			},
		})
	);
}

async function handleFetchGeneric(reqUrl: URL, res: http.ServerResponse) {
	const encodedUrl = reqUrl.searchParams.get('url');
	const headersParam = reqUrl.searchParams.get('headers') ?? undefined;
	if (!encodedUrl) return json(res, 400, { error: 'Missing url parameter' });

	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(encodedUrl));
	} catch {
		targetUrl = normalizeTargetUrl(encodedUrl);
	}
	const customHeaders = parseHeadersParam(headersParam);
	const upstream = await proxyFetch(targetUrl, customHeaders);

	res.statusCode = upstream.status;
	res.setHeader(
		'Content-Type',
		upstream.headers.get('content-type') || 'application/octet-stream'
	);
	res.setHeader('Access-Control-Allow-Origin', '*');
	upstream.body?.pipeTo(
		new WritableStream({
			write(chunk) {
				res.write(chunk);
			},
			close() {
				res.end();
			},
		})
	);
}

async function handleHLSSourceId(path: string, reqUrl: URL, res: http.ServerResponse) {
	const sourceid = path.split('/')[2] || '';
	const decoded = decodeSourceId(sourceid);
	if (!decoded) return json(res, 400, { error: 'Invalid sourceid' });

	const targetUrl = normalizeTargetUrl(decoded.url);
	const headers = decoded.headers || {};

	const upstream = await proxyFetch(targetUrl, headers);
	if (!upstream.ok) {
		res.statusCode = upstream.status;
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.end(await upstream.text());
		return;
	}

	const text = await upstream.text();
	const serverOrigin = `${reqUrl.protocol}//${reqUrl.host}`;

	const proxified = text
		.split('\n')
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#EXT')) {
				if (trimmed.includes('URI="')) {
					return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
						const absoluteUrl = new URL(uri, targetUrl).href;
						const segmentSourceId = Buffer.from(
							`url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(
								JSON.stringify(headers)
							)}`
						).toString('base64');
						const isPlaylist =
							absoluteUrl.includes('.m3u') || absoluteUrl.includes('playlist');
						const proxiedUrl = isPlaylist
							? `${serverOrigin}/hls/${segmentSourceId}`
							: `${serverOrigin}/ts/${segmentSourceId}`;
						return `URI="${proxiedUrl}"`;
					});
				}
				return line;
			}

			const absoluteUrl = new URL(trimmed, targetUrl).href;
			const segmentSourceId = Buffer.from(
				`url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(
					JSON.stringify(headers)
				)}`
			).toString('base64');
			const isPlaylist = absoluteUrl.includes('.m3u') || absoluteUrl.includes('playlist');
			if (isPlaylist) {
				return `${serverOrigin}/hls/${segmentSourceId}`;
			}
			return `${serverOrigin}/ts/${segmentSourceId}`;
		})
		.join('\n');

	res.statusCode = 200;
	res.setHeader(
		'Content-Type',
		upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl'
	);
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.end(proxified);
}

async function handleTSSourceId(path: string, res: http.ServerResponse) {
	const sourceid = path.split('/')[2] || '';
	const decoded = decodeSourceId(sourceid);
	if (!decoded) return json(res, 400, { error: 'Invalid sourceid' });
	const upstream = await proxyFetch(
		normalizeTargetUrl(decoded.url),
		decoded.headers || {}
	);

	if (!upstream.ok) {
		res.statusCode = upstream.status;
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.end(await upstream.text());
		return;
	}

	res.statusCode = 200;
	res.setHeader(
		'Content-Type',
		upstream.headers.get('content-type') || 'video/MP2T'
	);
	res.setHeader('Access-Control-Allow-Origin', '*');
	upstream.body?.pipeTo(
		new WritableStream({
			write(chunk) {
				res.write(chunk);
			},
			close() {
				res.end();
			},
		})
	);
}

async function handleMP4SourceId(
	req: http.IncomingMessage,
	path: string,
	res: http.ServerResponse
) {
	const sourceid = path.split('/')[2] || '';
	const decoded = decodeSourceId(sourceid);
	if (!decoded) return json(res, 400, { error: 'Invalid sourceid' });

	const customHeaders = decoded.headers || {};
	const clientRange = req.headers['range'] as string | undefined;
	if (clientRange) customHeaders['Range'] = clientRange;

	const upstream = await proxyFetch(
		normalizeTargetUrl(decoded.url),
		customHeaders
	);
	const status = upstream.status;

	if (status >= 400) {
		const errorText = await upstream.text().catch(() => 'Upstream error');
		return json(res, status, { error: 'Upstream error', status, message: errorText });
	}

	const finalStatus =
		status === 206 || (clientRange && status === 200) ? 206 : status;

	const headers: Record<string, string> = {
		'Content-Type': upstream.headers.get('content-type') || 'video/mp4',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
		'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
	};
	const len = upstream.headers.get('content-length');
	if (len) headers['Content-Length'] = len;
	const cr = upstream.headers.get('content-range');
	if (cr) headers['Content-Range'] = cr;
	const ar = upstream.headers.get('accept-ranges');
	if (ar) headers['Accept-Ranges'] = ar;

	res.statusCode = finalStatus;
	for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);

	upstream.body?.pipeTo(
		new WritableStream({
			write(chunk) {
				res.write(chunk);
			},
			close() {
				res.end();
			},
		})
	);
}

const server = http.createServer(async (req, res) => {
	if (!req.url || !req.headers.host) {
		return json(res, 400, { error: 'Invalid request' });
	}
	const url = new URL(req.url, `http://${req.headers.host}`);
	const path = url.pathname;

	// Simple CORS preflight
	if (req.method === 'OPTIONS') {
		res.statusCode = 204;
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
		return res.end();
	}

	try {
		if (path === '/m3u8-proxy') return await handleM3u8Proxy(url, res);
		if (path === '/ts-segment') return await handleTSSegment(url, res);
		if (path === '/mp4-proxy') return await handleMP4Proxy(req, url, res);
		if (path === '/fetch') return await handleFetchGeneric(url, res);

		if (path.startsWith('/hls/')) return await handleHLSSourceId(path, url, res);
		if (path.startsWith('/ts/')) return await handleTSSourceId(path, res);
		if (path.startsWith('/mp4/')) return await handleMP4SourceId(req, path, res);

		return json(res, 404, { error: 'Not Found', path });
	} catch (err: any) {
		console.error('Node normal proxy error:', err);
		return json(res, 500, { error: 'Internal Server Error', message: String(err) });
	}
});

const PORT = Number(process.env.PORT || 8788);
server.listen(PORT, () => {
	console.log(`Normal Node proxy listening on http://localhost:${PORT}`);
});

