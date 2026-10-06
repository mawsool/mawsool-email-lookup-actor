import { Actor, log } from 'apify';
import { createHash } from 'node:crypto';
import { lookupEmail, normalizeEmails } from './lookupClient.js';
import { errorDatasetRow, toDatasetRow } from './rowMapper.js';
import type { ActorInput } from './types.js';

const CHARGE_EVENT = 'email-lookup';
const HARD_MAX = 100_000;

function worthRetry(status: number | null, error: string): boolean {
    if (status === 403 || status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
    const text = error.toLowerCase();
    return text.includes('did not answer') || text.includes('fetch failed') || text.includes('network') || text.includes('unexpected response') || text.includes('temporarily') || text.includes('queue busy') || text.includes('timed out');
}

function recordKey(email: string): string {
    return createHash('sha256').update(email).digest('hex');
}

async function collectEmails(input: ActorInput): Promise<string[]> {
    const raw = [...(input.emails || [])];
    if (input.emailsCsv) raw.push(...input.emailsCsv.split(/[\s,;]+/));
    if (input.fileUrl) {
        const response = await fetch(input.fileUrl, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok) throw new Error(`Could not download input file (HTTP ${response.status}).`);
        raw.push(...(await response.text()).split(/[\s,;]+/));
    }
    return raw;
}

await Actor.init();

const input = (await Actor.getInput<ActorInput>()) || {};
const maxEmails = Math.min(Math.max(input.maxEmails ?? 100, 1), HARD_MAX);
const collected = await collectEmails(input);
const emails = normalizeEmails(collected).slice(0, maxEmails);

if (emails.length === 0) {
    throw new Error('No valid email addresses found. Add emails, paste a list, or upload a file.');
}

if (collected.length > emails.length) {
    log.warning(`Processing ${emails.length} valid unique emails (input contained invalid or duplicate entries, or was over the cap).`);
}

const concurrency = Math.min(Math.max(Number(input.concurrency ?? 10), 1), 40);
const progressId = (input.resumeId || 'auto').replace(/[^a-zA-Z0-9-_]/g, '-').slice(0, 60) || 'auto';
const saveProgress = emails.length > 20 || !!input.resumeId;
const skipFinished = saveProgress && !input.freshStart && (emails.length > 200 || !!input.resumeId);
const resumeStore = saveProgress
    ? await Actor.openKeyValueStore(input.resumeId ? `mawsool-email-resume-${progressId}` : 'mawsool-email-progress-auto')
    : null;

log.info(`Starting ${emails.length} verified email lookup(s), concurrency=${concurrency}.`);
if (skipFinished) log.info('Finished emails from an earlier run of this list are skipped. Set freshStart to look them up again.');

let batch = emails;
let deferFailures = emails.length > 1;
let nextIndex = 0;
const deferred: string[] = [];
let processed = 0;
let found = 0;
let failed = 0;
let skipped = 0;
let stop = false;
let consecutiveOutages = 0;

function noteOutcome(message: string | null): void {
    if (!message) {
        consecutiveOutages = 0;
        return;
    }
    if (!worthRetry(null, message) && !/http 5\d\d|403|429|502|503|504/.test(message.toLowerCase())) {
        consecutiveOutages = 0;
        return;
    }
    consecutiveOutages += 1;
    if (consecutiveOutages >= 15 && !stop) {
        stop = true;
        log.error('The lookup service looks unavailable. Stopping so finished rows stay saved and the next run can continue.');
    }
}

async function recordEmail(email: string, allowDefer: boolean): Promise<void> {
    const key = `done-${recordKey(email)}`;
    if (skipFinished && resumeStore && await resumeStore.getValue(key)) {
        skipped += 1;
        return;
    }
    try {
        const result = await lookupEmail(email);
        const row = toDatasetRow(email, result);
        if (allowDefer && !stop && !row.success && worthRetry(row.statusCode, row.error || '')) {
            noteOutcome(row.error || 'temporary failure');
            deferred.push(email);
            log.warning(`Email lookup failed and will be retried at the end: ${row.error}`);
            return;
        }
        const charge = await Actor.pushData(row, CHARGE_EVENT);
        if (charge?.eventChargeLimitReached) stop = true;
        if (resumeStore && row.success) await resumeStore.setValue(key, { at: new Date().toISOString() });
        noteOutcome(row.success ? null : (worthRetry(row.statusCode, row.error || '') ? row.error || 'temporary failure' : null));
        processed += 1;
        if (row.success && row.hasLinkedIn) found += 1;
        if (!row.success) failed += 1;
        log.info(`Processed ${email}: ${row.success ? (row.hasLinkedIn ? 'LinkedIn profile confirmed' : 'no LinkedIn on this email') : `error (${row.error})`}`);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unexpected lookup error';
        noteOutcome(message);
        if (allowDefer && !stop && worthRetry(null, message)) {
            deferred.push(email);
            log.warning(`Email lookup failed and will be retried at the end: ${message}`);
            return;
        }
        const charge = await Actor.pushData(errorDatasetRow(email, message), CHARGE_EVENT);
        if (charge?.eventChargeLimitReached) stop = true;
        failed += 1;
        processed += 1;
        log.error(`Lookup failed for ${email}: ${message}`);
    }
}

async function runBatch(): Promise<void> {
    nextIndex = 0;
    const workers = Math.min(concurrency, batch.length);
    if (!workers) return;
    await Promise.all(Array.from({ length: workers }, async () => {
        while (!stop) {
            const index = nextIndex++;
            if (index >= batch.length) return;
            await recordEmail(batch[index], deferFailures);
        }
    }));
}

await runBatch();
if (deferred.length && !stop) {
    log.info(`Retrying ${deferred.length} email lookup(s) that failed on the first pass.`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    batch = deferred.splice(0, deferred.length);
    deferFailures = false;
    await runBatch();
}

await Actor.setValue('OUTPUT', {
    processed,
    found,
    failed,
    skipped,
    totalInputEmails: collected.length,
    processedEmails: emails.length,
    stoppedByChargeLimit: stop,
});

log.info(`Finished. Processed: ${processed}, LinkedIn profiles found: ${found}, failed: ${failed}, skipped: ${skipped}`);
await Actor.exit();
