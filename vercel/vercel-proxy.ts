import type { VercelRequest, VercelResponse } from '@vercel/node';

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

function json(res: VercelResponse, status: number, data: unknown) {
	res
		.status(status)
		.setHeader('Content-Type', 'application/json')
		.setHeader('Access-Control-Allow-Origin', '*')
		.send(JSON.stringify(data, null, 2));
}

function parseHeadersParam(headersParam?: string | string[]): Record<string, string> {
	if (!headersParam) return {};
	const raw = Array.isArray(headersParam) ? headersParam[0] : headersParam;
	const custom: Record<string, string> = {};
	try {
		const parsed = JSON.parse(decodeURIComponent(raw));
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

async function handleM3u8Proxy(req: VercelRequest, res: VercelResponse) {
	const { url: encodedUrl, headers: headersParam } = req.query;
	if (!encodedUrl) return json(res, 400, { error: 'Missing url parameter' });

	let targetUrl: string;
	const rawUrl = Array.isArray(encodedUrl) ? encodedUrl[0] : encodedUrl;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(rawUrl));
	} catch {
		targetUrl = normalizeTargetUrl(rawUrl);
	}

	const customHeaders = parseHeadersParam(headersParam);
	const upstream = await proxyFetch(targetUrl, customHeaders);
	if (!upstream.ok) {
		res
			.status(upstream.status)
			.setHeader('Access-Control-Allow-Origin', '*')
			.send(await upstream.text());
		return;
	}

	const text = await upstream.text();
	const serverOrigin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
	const rawHeadersParam = Array.isArray(headersParam) ? headersParam[0] : headersParam;
	const encodedHeaders = rawHeadersParam ? encodeURIComponent(rawHeadersParam) : '';

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
							? `${serverOrigin}/api/vercel-proxy/m3u8-proxy?url=${encUrl}${
									encodedHeaders ? `&headers=${encodedHeaders}` : ''
								}`
							: `${serverOrigin}/api/vercel-proxy/fetch?url=${encUrl}${
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
				return `${serverOrigin}/api/vercel-proxy/m3u8-proxy?url=${encUrl}${
					encodedHeaders ? `&headers=${encodedHeaders}` : ''
				}`;
			}
			return `${serverOrigin}/api/vercel-proxy/ts-segment?url=${encUrl}${
				encodedHeaders ? `&headers=${encodedHeaders}` : ''
			}`;
		})
		.join('\n');

	res
		.status(200)
		.setHeader(
			'Content-Type',
			upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl'
		)
		.setHeader('Access-Control-Allow-Origin', '*')
		.send(proxified);
}

async function handleTSSegment(req: VercelRequest, res: VercelResponse) {
	const { url: encodedUrl, headers: headersParam } = req.query;
	if (!encodedUrl) return json(res, 400, { error: 'Missing url parameter' });

	const rawUrl = Array.isArray(encodedUrl) ? encodedUrl[0] : encodedUrl;
	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(rawUrl));
	} catch {
		targetUrl = normalizeTargetUrl(rawUrl);
	}
	const customHeaders = parseHeadersParam(headersParam);
	const upstream = await proxyFetch(targetUrl, customHeaders);

	if (!upstream.ok) {
		res
			.status(upstream.status)
			.setHeader('Access-Control-Allow-Origin', '*')
			.send(await upstream.text());
		return;
	}

	res
		.status(200)
		.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/MP2T')
		.setHeader('Access-Control-Allow-Origin', '*');

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

async function handleMP4Proxy(req: VercelRequest, res: VercelResponse) {
	const { url: encodedUrl, headers: headersParam } = req.query;
	if (!encodedUrl) return json(res, 400, { error: 'Missing url parameter' });

	const rawUrl = Array.isArray(encodedUrl) ? encodedUrl[0] : encodedUrl;
	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(rawUrl));
	} catch {
		targetUrl = normalizeTargetUrl(rawUrl);
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

	res.status(finalStatus).setHeader('Access-Control-Allow-Origin', '*');
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

async function handleFetchGeneric(req: VercelRequest, res: VercelResponse) {
	const { url: encodedUrl, headers: headersParam } = req.query;
	if (!encodedUrl) return json(res, 400, { error: 'Missing url parameter' });

	const rawUrl = Array.isArray(encodedUrl) ? encodedUrl[0] : encodedUrl;
	let targetUrl: string;
	try {
		targetUrl = normalizeTargetUrl(decodeURIComponent(rawUrl));
	} catch {
		targetUrl = normalizeTargetUrl(rawUrl);
	}
	const customHeaders = parseHeadersParam(headersParam);
	const upstream = await proxyFetch(targetUrl, customHeaders);

	res
		.status(upstream.status)
		.setHeader(
			'Content-Type',
			upstream.headers.get('content-type') || 'application/octet-stream'
		)
		.setHeader('Access-Control-Allow-Origin', '*');

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

export default async function handler(req: VercelRequest, res: VercelResponse) {
	// CORS preflight
	if (req.method === 'OPTIONS') {
		res
			.status(204)
			.setHeader('Access-Control-Allow-Origin', '*')
			.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS, HEAD')
			.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
			.end();
		return;
	}

	const path = (req.query.path as string | string[] | undefined) || '';
	const p = Array.isArray(path) ? path.join('/') : path;

	try {
		if (p === 'm3u8-proxy') return await handleM3u8Proxy(req, res);
		if (p === 'ts-segment') return await handleTSSegment(req, res);
		if (p === 'mp4-proxy') return await handleMP4Proxy(req, res);
		if (p === 'fetch') return await handleFetchGeneric(req, res);

		// For brevity, hls/mp4/ts sourceid endpoints can be implemented here
		// similarly to the Deno version if needed.

		return json(res, 404, { error: 'Not Found', path: p });
	} catch (err: any) {
		console.error('Vercel proxy error:', err);
		return json(res, 500, { error: 'Internal Server Error', message: String(err) });
	}
}
