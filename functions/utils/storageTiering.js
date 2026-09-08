import { fetchUploadConfig } from './sysConfig.js';
import { reserveR2 } from './r2Capacity.js';
import { getDatabase } from './databaseAdapter.js';
export { enqueueTelegramBackup as backupFileIdToTelegram } from './telegramBackup.js';

const DEFAULT_R2_FREE_LIMIT_GB = 10;
const DEFAULT_R2_SWITCH_THRESHOLD = 95;
const AUTOMATIC_R2_CHUNK_SIZE = 16 * 1024 * 1024;
const DECIMAL_GB = 1000 * 1000 * 1000;
const BINARY_MB = 1024 * 1024;

function toFiniteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampThreshold(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_R2_SWITCH_THRESHOLD;
    return Math.min(100, Math.max(1, parsed));
}

function getTieringPolicy(env, r2Channels = []) {
    const configuredQuota = r2Channels.find(
        channel => channel?.quota?.enabled && Number(channel?.quota?.limitGB) > 0
    )?.quota;

    const limitGB = toFiniteNumber(
        env.R2_AUTO_TIER_LIMIT_GB,
        toFiniteNumber(configuredQuota?.limitGB, DEFAULT_R2_FREE_LIMIT_GB)
    );
    const threshold = clampThreshold(
        env.R2_AUTO_TIER_THRESHOLD ?? configuredQuota?.threshold ?? DEFAULT_R2_SWITCH_THRESHOLD
    );

    return {
        limitGB,
        threshold,
        limitBytes: limitGB * DECIMAL_GB,
    };
}

function normalizePrimaryChannel(channel) {
    const value = String(channel || '').toLowerCase();
    if (value === 'cloudflarer2' || value === 'cfr2' || value === 'r2') return 'cfr2';
    if (value === 'huggingface' || value === 'hf') return 'huggingface';
    if (value === 'telegramnew' || value === 'telegram' || value === 'tg') return 'telegram';
    if (value === 'external') return 'external';
    return value;
}

async function estimateIncomingBytes(request, url) {
    if (url.searchParams.get('initChunked') !== 'true') {
        const contentLength = Number(request.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > 0) {
            return contentLength;
        }
    }

    try {
        const formdata = await request.clone().formData();
        const actualFile = formdata.get('file');
        if (actualFile && typeof actualFile.size === 'number') return actualFile.size;
        const sizeFields = ['originalFileSize', 'fileSizeBytes', 'totalSize', 'fileSize'];
        for (const key of sizeFields) {
            const value = Number(formdata.get(key));
            if (Number.isFinite(value) && value > 0) {
                if (key === 'fileSize' && value < BINARY_MB) {
                    return value * BINARY_MB;
                }
                return value;
            }
        }

        const file = formdata.get('file');
        if (file && typeof file.size === 'number') {
            return file.size;
        }

        // The existing frontend does not send originalFileSize when it initializes
        // an R2 multipart upload. Estimate conservatively from totalChunks so a large
        // upload cannot start at 94.x% and silently push R2 beyond the 95% safety line.
        if (url.searchParams.get('initChunked') === 'true') {
            const totalChunks = Number(formdata.get('totalChunks'));
            if (Number.isInteger(totalChunks) && totalChunks > 0) {
                return totalChunks * AUTOMATIC_R2_CHUNK_SIZE;
            }
        }
    } catch (error) {
        console.warn('Storage tiering: failed to estimate upload size:', error.message);
    }

    return 0;
}

export async function resolveAutomaticPrimary(context, request = context.request) {
    const config = await fetchUploadConfig(context.env);
    const r2 = config.cfr2?.channels || [];
    const hf = config.huggingface?.channels || [];
    const policy = getTieringPolicy(context.env, r2);
    const incomingBytes = Math.ceil(await estimateIncomingBytes(request, new URL(request.url)));
    if (context.env.img_r2 && r2.length) {
        const reservation = await reserveR2(context.env.img_r2, incomingBytes,
            policy.limitBytes * policy.threshold / 100,
            new URL(request.url).searchParams.get('initChunked') === 'true' ? 2 * 3600000 : 24 * 3600000);
        if (reservation.id) return { channel: 'cfr2', reservationId: reservation.id, incomingBytes };
        return { channel: hf.length ? 'huggingface' : null,
            reason: hf.length ? 'r2_threshold_reached' : 'r2_threshold_reached_hf_unavailable',
            ...reservation, incomingBytes, threshold: policy.threshold, limitGB: policy.limitGB };
    }
    return { channel: hf.length ? 'huggingface' : null, reason: hf.length ? 'r2_unavailable' : 'no_primary_storage' };
}

export function isAutomaticChannelRequest(url) {
    const tiering = String(url.searchParams.get('tiering') || '').toLowerCase();
    const forcePrimary = String(url.searchParams.get('forcePrimary') || '').toLowerCase();
    if (['off', 'false', '0', 'disabled'].includes(tiering) || forcePrimary === 'true') {
        return false;
    }

    const requested = normalizePrimaryChannel(url.searchParams.get('uploadChannel'));
    // The stock web UI always sends a concrete uploadChannel. Treat its normal R2
    // selection as the automatic R2->HF tier so the 95% switch actually works.
    // API clients can still force R2 with ?tiering=off (or ?forcePrimary=true).
    return !requested || requested === 'auto' || requested === 'cfr2';
}

export function shouldScheduleTelegramBackup(primaryChannel, url) {
    if (url.searchParams.get('tgBackup') === 'false') return false;
    const normalized = normalizePrimaryChannel(primaryChannel);
    return normalized !== 'telegram' && normalized !== 'external' && normalized !== '';
}

async function readPrimaryChannelFromChunkSession(context, request) {
    try {
        const formdata = await request.clone().formData();
        const uploadId = formdata.get('uploadId');
        if (!uploadId) return '';

        const db = getDatabase(context.env);
        const sessionData = await db.get(`upload_session_${uploadId}`);
        if (!sessionData) return '';
        const session = JSON.parse(sessionData);
        return normalizePrimaryChannel(session.uploadChannel);
    } catch (error) {
        console.warn('Storage tiering: failed to read chunk session:', error.message);
        return '';
    }
}

export async function resolveEffectivePrimaryForRequest(context, request, fallbackChannel = '') {
    const url = new URL(request.url);
    if (url.searchParams.get('merge') === 'true') {
        const sessionChannel = await readPrimaryChannelFromChunkSession(context, request);
        return sessionChannel || normalizePrimaryChannel(fallbackChannel);
    }
    return normalizePrimaryChannel(url.searchParams.get('uploadChannel') || fallbackChannel);
}

export async function extractUploadedFileId(response) {
    try {
        const payload = await response.clone().json();
        const first = Array.isArray(payload) ? payload[0] : payload;
        const src = first?.src || first?.publicUrl || '';
        if (!src) return '';

        if (src.startsWith('/file/')) return decodeURIComponent(src.slice('/file/'.length));
        const marker = '/file/';
        const markerIndex = src.indexOf(marker);
        if (markerIndex >= 0) return decodeURIComponent(src.slice(markerIndex + marker.length));

        try {
            const parsed = new URL(src);
            return decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
        } catch {
            return decodeURIComponent(String(src).replace(/^\/+/, ''));
        }
    } catch (error) {
        console.warn('Telegram backup: failed to parse upload response:', error.message);
        return '';
    }
}
