// Deno proxy entrypoint – compatible with the Cloudflare Worker proxy format.
// Run locally:
//   deno run --allow-net deno-proxy.ts

const DEFAULT_FETCH_HEADERS: Record<string, string> = {
	'User-Agent':
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
	Accept: '*/*',
	'Accept-Language': '*',
	'Accept-Encoding': 'gzip, deflate, br',
};

function normalizeTargetUrl(url: string): string {
	// Fix multiple '?' in query
	const qIdx = url.indexOf('?');
	let normalized = url;
	if (qIdx !== -1) {
		normalized = url.slice(0, qIdx + 1) + url.slice(qIdx + 1).replace(/\?/g, '&');
	}
	return normalized;
}

function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

function parseHeadersParam(headersParam: string | null): Record<string, string> {
	if (!headersParam) return {};
	const custom: Record<string, string> = {};
	try {
		const parsed = JSON.parse(decodeURIComponent(headersParam));
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
		// Ignore parse errors; caller can still proceed without custom headers
	}
	return custom;
}

function decodeSourceId(sourceid: string): { url: string; headers: Record<string, string> } | null {
	try {
		const decoded = atob(sourceid);
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
		return {
			url: decodeURIComponent(urlParam),
			headers,
		};
	} catch {
		return null;
	}
}

async function proxyFetch(
	targetUrl: string,
	customHeaders: Record<string, string>,
	init: RequestInit = {}
): Promise<Response> {
	const url = normalizeTargetUrl(targetUrl);
	return fetch(url, {
		...init,
		headers: { ...DEFAULT_FETCH_HEADERS, ...customHeaders },
	});
}

async function handleM3u8Proxy(reqUrl: URL): Promise<Response> {
	const encodedUrl = reqUrl.searchParams.get('url');
	const headersParam = reqUrl.searchParams.get('headers');
	if (!encodedUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);

	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(encodedUrl));
	} catch {
		targetUrl = normalizeTargetUrl(encodedUrl);
	}

	const customHeaders = parseHeadersParam(headersParam);
	const res = await proxyFetch(targetUrl, customHeaders);

	if (!res.ok) {
		return new Response(res.body, {
			status: res.status,
			headers: { 'Access-Control-Allow-Origin': '*' },
		});
	}

	const text = await res.text();
	const serverOrigin = reqUrl.origin;
	const encodedHeaders = headersParam ? encodeURIComponent(headersParam) : '';

	const proxified = text
		.split('\n')
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#EXT')) {
				// Rewrite URI attributes inside EXT tags
				if (trimmed.includes('URI="')) {
					return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
						const absoluteUrl = new URL(uri, targetUrl).href;
						const encUrl = encodeURIComponent(absoluteUrl);
						const isPlaylist = absoluteUrl.includes('.m3u') || absoluteUrl.includes('playlist');
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

			// Regular segment or nested playlist lines
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

	return new Response(proxified, {
		headers: {
			'Content-Type': res.headers.get('Content-Type') || 'application/vnd.apple.mpegurl',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

async function handleTSSegment(reqUrl: URL): Promise<Response> {
	const encodedUrl = reqUrl.searchParams.get('url');
	const headersParam = reqUrl.searchParams.get('headers');
	if (!encodedUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);

	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(encodedUrl));
	} catch {
		targetUrl = normalizeTargetUrl(encodedUrl);
	}
	const customHeaders = parseHeadersParam(headersParam);
	const res = await proxyFetch(targetUrl, customHeaders);

	if (!res.ok) {
		return new Response(res.body, {
			status: res.status,
			headers: { 'Access-Control-Allow-Origin': '*' },
		});
	}

	return new Response(res.body, {
		headers: {
			'Content-Type': res.headers.get('Content-Type') || 'video/MP2T',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

async function handleMP4Proxy(req: Request, reqUrl: URL): Promise<Response> {
	const encodedUrl = reqUrl.searchParams.get('url');
	const headersParam = reqUrl.searchParams.get('headers');
	if (!encodedUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);

	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(encodedUrl));
	} catch {
		targetUrl = normalizeTargetUrl(encodedUrl);
	}

	const customHeaders = parseHeadersParam(headersParam);
	const clientRange = req.headers.get('range');
	if (clientRange) {
		customHeaders['Range'] = clientRange;
	}

	const res = await proxyFetch(targetUrl, customHeaders);
	const status = res.status;

	if (status >= 400) {
		const errorText = await res.text().catch(() => 'Upstream error');
		return jsonResponse({ error: 'Upstream error', status, message: errorText }, status);
	}

	const finalStatus = status === 206 || (clientRange && status === 200) ? 206 : status;
	const headers: Record<string, string> = {
		'Content-Type': res.headers.get('Content-Type') || 'video/mp4',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
		'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
	};
	const len = res.headers.get('content-length');
	if (len) headers['Content-Length'] = len;
	const cr = res.headers.get('content-range');
	if (cr) headers['Content-Range'] = cr;
	const ar = res.headers.get('accept-ranges');
	if (ar) headers['Accept-Ranges'] = ar;

	return new Response(res.body, { status: finalStatus, headers });
}

async function handleFetchGeneric(reqUrl: URL): Promise<Response> {
	const encodedUrl = reqUrl.searchParams.get('url');
	const headersParam = reqUrl.searchParams.get('headers');
	if (!encodedUrl) return jsonResponse({ error: 'Missing url parameter' }, 400);

	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(encodedUrl));
	} catch {
		targetUrl = normalizeTargetUrl(encodedUrl);
	}
	const customHeaders = parseHeadersParam(headersParam);
	const res = await proxyFetch(targetUrl, customHeaders);

	return new Response(res.body, {
		status: res.status,
		headers: {
			'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

// /hls/:sourceid – decode sourceid and proxy M3U8, with inner URLs rewritten to /hls/:sourceid or /ts/:sourceid
async function handleHLSSourceId(path: string, reqUrl: URL): Promise<Response> {
	const sourceid = path.split('/')[2] || '';
	const decoded = decodeSourceId(sourceid);
	if (!decoded) return jsonResponse({ error: 'Invalid sourceid' }, 400);

	const targetUrl = normalizeTargetUrl(decoded.url);
	const headers = decoded.headers || {};

	const res = await proxyFetch(targetUrl, headers);
	if (!res.ok) {
		return new Response(res.body, {
			status: res.status,
			headers: { 'Access-Control-Allow-Origin': '*'},
		});
	}

	const text = await res.text();
	const serverOrigin = reqUrl.origin;

	const proxified = text
		.split('\n')
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#EXT')) {
				if (trimmed.includes('URI="')) {
					return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
						const absoluteUrl = new URL(uri, targetUrl).href;
						const segmentSourceId = btoa(
							`url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(
								JSON.stringify(headers)
							)}`
						);
						const isPlaylist = absoluteUrl.includes('.m3u') || absoluteUrl.includes('playlist');
						const proxiedUrl = isPlaylist
							? `${serverOrigin}/hls/${segmentSourceId}`
							: `${serverOrigin}/ts/${segmentSourceId}`;
						return `URI="${proxiedUrl}"`;
					});
				}
				return line;
			}

			const absoluteUrl = new URL(trimmed, targetUrl).href;
			const segmentSourceId = btoa(
				`url=${encodeURIComponent(absoluteUrl)}&headers=${encodeURIComponent(
					JSON.stringify(headers)
				)}`
			);
			const isPlaylist = absoluteUrl.includes('.m3u') || absoluteUrl.includes('playlist');
			if (isPlaylist) {
				return `${serverOrigin}/hls/${segmentSourceId}`;
			}
			return `${serverOrigin}/ts/${segmentSourceId}`;
		})
		.join('\n');

	return new Response(proxified, {
		headers: {
			'Content-Type': res.headers.get('Content-Type') || 'application/vnd.apple.mpegurl',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

async function handleTSSourceId(path: string): Promise<Response> {
	const sourceid = path.split('/')[2] || '';
	const decoded = decodeSourceId(sourceid);
	if (!decoded) return jsonResponse({ error: 'Invalid sourceid' }, 400);
	const res = await proxyFetch(normalizeTargetUrl(decoded.url), decoded.headers || {});

	if (!res.ok) {
		return new Response(res.body, {
			status: res.status,
			headers: { 'Access-Control-Allow-Origin': '*'},
		});
	}

	return new Response(res.body, {
		headers: {
			'Content-Type': res.headers.get('Content-Type') || 'video/MP2T',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

async function handleMP4SourceId(req: Request, path: string): Promise<Response> {
	const sourceid = path.split('/')[2] || '';
	const decoded = decodeSourceId(sourceid);
	if (!decoded) return jsonResponse({ error: 'Invalid sourceid' }, 400);

	const customHeaders = decoded.headers || {};
	const clientRange = req.headers.get('range');
	if (clientRange) customHeaders['Range'] = clientRange;

	const res = await proxyFetch(normalizeTargetUrl(decoded.url), customHeaders);
	const status = res.status;

	if (status >= 400) {
		const errorText = await res.text().catch(() => 'Upstream error');
		return jsonResponse({ error: 'Upstream error', status, message: errorText }, status);
	}

	const finalStatus = status === 206 || (clientRange && status === 200) ? 206 : status;

	const headers: Record<string, string> = {
		'Content-Type': res.headers.get('Content-Type') || 'video/mp4',
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
		'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
	};
	const len = res.headers.get('content-length');
	if (len) headers['Content-Length'] = len;
	const cr = res.headers.get('content-range');
	if (cr) headers['Content-Range'] = cr;
	const ar = res.headers.get('accept-ranges');
	if (ar) headers['Accept-Ranges'] = ar;

	return new Response(res.body, { status: finalStatus, headers });
}

Deno.serve(async (req: Request) => {
	const url = new URL(req.url);
	const path = url.pathname;

	// Simple CORS preflight
	if (req.method === 'OPTIONS') {
		return new Response(null, {
			headers: {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
				'Access-Control-Allow-Headers': 'Content-Type, Range',
			},
		});
	}

	try {
		if (path === '/m3u8-proxy') {
			return await handleM3u8Proxy(url);
		}
		if (path === '/ts-segment') {
			return await handleTSSegment(url);
		}
		if (path === '/mp4-proxy') {
			return await handleMP4Proxy(req, url);
		}
		if (path === '/fetch') {
			return await handleFetchGeneric(url);
		}

		if (path.startsWith('/hls/')) {
			return await handleHLSSourceId(path, url);
		}
		if (path.startsWith('/ts/')) {
			return await handleTSSourceId(path);
		}
		if (path.startsWith('/mp4/')) {
			return await handleMP4SourceId(req, path);
		}

		return jsonResponse({ error: 'Not Found' }, 404);
	} catch (err) {
		console.error('Deno proxy error:', err);
		return jsonResponse({ error: 'Internal Server Error' }, 500);
	}
});


