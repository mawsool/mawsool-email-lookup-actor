import { log } from 'apify';
import type { LookupApiResponse } from './types.js';

const LOOKUP_ROUTE = 'deep-v2';
const DEFAULT_PRIMARY_BASE_URL = '';
const DEFAULT_FALLBACK_BASE_URL = '';
const RETRY_DELAY_MS = 1000;
const PRIMARY_ATTEMPTS = 4;
const FALLBACK_ATTEMPTS = 2;
const LOOKUP_TIMEOUT_MS = 45_000;

export function getApiBaseUrl(): string {
    return (process.env.MAWSOOL_API_BASE_URL || DEFAULT_PRIMARY_BASE_URL).replace(/\/$/, '');
}

export function getFallbackApiBaseUrl(): string {
    return (process.env.MAWSOOL_API_FALLBACK_BASE_URL || DEFAULT_FALLBACK_BASE_URL).replace(/\/$/, '');
}

export function getApiKey(): string {
    const key = process.env.MAWSOOL_API_KEY?.trim();
    if (!key) {
        throw new Error(
            'MAWSOOL_API_KEY is not configured. Set it as a Secret environment variable in the Apify Console (Settings → Environment variables).',
        );
    }
    return key;
}

function getFallbackApiKey(): string {
    return (process.env.MAWSOOL_API_FALLBACK_KEY || process.env.MAWSOOL_API_KEY || '').trim();
}

export function normalizeEmails(raw: string[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const value of raw) {
        if (typeof value !== 'string') continue;
        const email = value.trim().toLowerCase();
        if (!email || !email.includes('@')) continue;
        if (seen.has(email)) continue;
        seen.add(email);
        normalized.push(email);
    }

    return normalized;
}

function parseJsonBody(text: string): (LookupApiResponse & { error?: string }) | null {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('<')) return null;
    try {
        return JSON.parse(trimmed) as LookupApiResponse & { error?: string };
    } catch {
        return null;
    }
}

function htmlErrorHint(): string {
    return 'The lookup service returned an unexpected response. Please try again shortly.';
}

function publicError(message: string): string {
    return message.replace(/https?:\/\/\S+/gi, 'the lookup service');
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientLookupFailure(result: LookupApiResponse): boolean {
    if (result.success) return false;
    const status = result.statusCode || 0;
    const error = (result.error || '').toLowerCase();
    if (status === 403 || status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
    if (error.includes('temporarily unavailable')) return true;
    if (error.includes('lookup queue busy')) return true;
    if (error.includes('unexpected response') || error.includes('html instead of json')) return true;
    if (error.includes('did not answer in time')) return true;
    if (error.includes('network request failed') || error.includes('fetch failed') || error.includes('timed out') || error.includes('network')) return true;
    return false;
}

async function lookupEmailOnce(
    email: string,
    baseUrl: string,
    apiKey: string,
): Promise<LookupApiResponse> {
    const url = `${baseUrl.replace(/\/$/, '')}`;

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'Mawsool-Apify-Actor/2.2',
                'X-API-Key': apiKey,
            },
            body: JSON.stringify({ email }),
            signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
        });
    } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        const message = timedOut ? 'The lookup did not answer in time.' : publicError(err instanceof Error ? err.message : 'Network request failed');
        return {
            success: false,
            method: LOOKUP_ROUTE,
            email,
            error: message,
            statusCode: 502,
        };
    }

    const rawText = await response.text();
    const body = parseJsonBody(rawText);

    if (!body) {
        return {
            success: false,
            method: LOOKUP_ROUTE,
            email,
            error: htmlErrorHint(),
            statusCode: response.status || 502,
        };
    }

    if (!response.ok) {
        return {
            success: false,
            method: LOOKUP_ROUTE,
            email,
            error: body.error || `Lookup failed with HTTP ${response.status}`,
            statusCode: response.status,
        };
    }

    return body;
}

async function tryLookup(
    attempts: number,
    run: () => Promise<LookupApiResponse>,
): Promise<LookupApiResponse> {
    let result = await run();
    for (let attempt = 1; attempt < attempts && isTransientLookupFailure(result); attempt += 1) {
        log.warning(`Email lookup attempt ${attempt} of ${attempts} did not succeed. Retrying.`);
        await sleep(Math.min(8000, RETRY_DELAY_MS * (2 ** (attempt - 1))));
        result = await run();
    }
    return result;
}

/**
 * Primary API, several retries on temporary failures, then the fallback API.
 */
export async function lookupEmail(email: string): Promise<LookupApiResponse> {
    const primaryBase = getApiBaseUrl();
    const primaryKey = getApiKey();
    const fallbackBase = getFallbackApiBaseUrl();
    const fallbackKey = getFallbackApiKey();

    const result = await tryLookup(PRIMARY_ATTEMPTS, () => lookupEmailOnce(email, primaryBase, primaryKey));
    if (!isTransientLookupFailure(result) || !fallbackKey || fallbackBase === primaryBase) return result;

    log.warning('Primary email lookup did not succeed. Trying the backup lookup service.');
    return tryLookup(FALLBACK_ATTEMPTS, () => lookupEmailOnce(email, fallbackBase, fallbackKey));
}
