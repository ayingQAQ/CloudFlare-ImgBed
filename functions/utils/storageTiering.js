import { fetchUploadConfig } from './sysConfig.js';
import { getIndexMeta } from './indexManager.js';
import { getDatabase } from './databaseAdapter.js';
import { TelegramAPI } from './storage/telegramAPI.js';

const DEFAULT_R2_FREE_LIMIT_GB = 10;
const DEFAULT_R2_SWITCH_THRESHOLD = 95;
const TELEGRAM_BACKUP_CHUNK_SIZE = 16 * 1024 * 1024;
const TELEGRAM_BACKUP_MAX_CHUNKS = 50;
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
    const configuredQuota = r2Channels.find(channel => channel?.quota?.enabled && Number(channel?.quota?.limitGB) > 0)?.quota;
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
    // For normal multipart uploads Content-Length is a safe upper-bound and avoids
    // materialising the file merely to decide the storage tier.
    if (url.searchParams.get('initChunked') !== 'true') {
        const contentLength = Number(request.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > 0) {
            return contentLength;
        }
    }

    try {
        const formdata = await request.clone().formData();
        const sizeFields = ['originalFileSize', 'fileSizeBytes', 'totalSize', 'fileSize'];
        for (const key of sizeFields) {
            const value = Number(formdata.get(key));
            if (Number.isFinite(value) && value > 0) {
                // fileSize may be supplied in MB by some clients; the explicit byte
                // fields above are preferred. Treat a small bare fileSize as MB.
                if (key === 'fileSize' && value < 1024 * 1024) {
                    return value * BINARY_MB;
                }
                return value;
            }
        }

        const file = formdata.get('file');
        if (file && typeof file.size === 'number') {
            return file.size;
        }
    } catch (error) {
        console.warn('Storage tiering: failed to estimate upload size:', error.message);
    }

    return 0;
}

function calculateR2UsedBytes(indexMeta, r2Channels) {
    const channelStats = indexMeta?.channelStats || {};
    const r2Names = new Set((r2Channels || []).map(channel => channel?.name).filter(Boolean));

    // The environment R2 channel has historically been named R2_env. Include it
    // even if quota filtering removed it from the currently available list.
    r2Names.add('R2_env');

    let usedMB = 0;
    for (const [channelName, stats] of Object.entries(channelStats)) {
        if (r2Names.has(channelName)) {
            usedMB += Number(stats?.usedMB) || 0;
        }
    }
    return usedMB * BINARY_MB;
}

/**
 * Resolve the automatic primary storage target.
 *
 * Default policy:
 *   R2 while projected managed usage is below 95% of 10 GB (decimal), then HF.
 *
 * Both the limit and threshold can be overridden without code changes:
 *   R2_AUTO_TIER_LIMIT_GB=10
 *   R2_AUTO_TIER_THRESHOLD=95
 */
export async function resolveAutomaticPrimary(context, request = context.request) {
    const { env } = context;
    const url = new URL(request.url);
    const uploadConfig = await fetchUploadConfig(env, context);
    const r2Channels = uploadConfig?.cfr2?.channels || [];
    const hfChannels = uploadConfig?.huggingface?.channels || [];
    const hasR2 = Boolean(env.img_r2) && r2Channels.length > 0;
    const hasHF = hfChannels.length > 0;

    if (!hasR2 && hasHF) {
        return {
            channel: 'huggingface',
            reason: 'r2_unavailable',
            r2UsagePercent: null,
        };
    }

    if (!hasR2 && !hasHF) {
        return {
            channel: null,
            reason: 'no_primary_storage',
            r2UsagePercent: null,
        };
    }

    const policy = getTieringPolicy(env, r2Channels);
    const indexMeta = await getIndexMeta(context);
    const usedBytes = calculateR2UsedBytes(indexMeta, r2Channels);
    const incomingBytes = await estimateIncomingBytes(request, url);
    const projectedBytes = usedBytes + incomingBytes;
    const usagePercent = policy.limitBytes > 0 ? (usedBytes / policy.limitBytes) * 100 : 0;
    const projectedPercent = policy.limitBytes > 0 ? (projectedBytes / policy.limitBytes) * 100 : 0;

    if (projectedPercent < policy.threshold) {
        return {
            channel: 'cfr2',
            reason: 'r2_below_threshold',
            usedBytes,
            incomingBytes,
            projectedBytes,
            r2UsagePercent: usagePercent,
            projectedPercent,
            threshold: policy.threshold,
            limitGB: policy.limitGB,
        };
    }

    if (hasHF) {
        return {
            channel: 'huggingface',
            reason: 'r2_threshold_reached',
            usedBytes,
            incomingBytes,
            projectedBytes,
            r2UsagePercent: usagePercent,
            projectedPercent,
            threshold: policy.threshold,
            limitGB: policy.limitGB,
        };
    }

    // Do not silently cross the configured/free R2 safety threshold when HF is
    // missing. The caller can still explicitly select R2 if that is intentional.
    return {
        channel: null,
        reason: 'r2_threshold_reached_hf_unavailable',
        usedBytes,
        incomingBytes,
        projectedBytes,
        r2UsagePercent: usagePercent,
        projectedPercent,
        threshold: policy.threshold,
        limitGB: policy.limitGB,
    };
}

export function isAutomaticChannelRequest(url) {
    const requested = url.searchParams.get('uploadChannel');
    return !requested || requested === 'auto';
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

async function extractFileId(response) {
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

async function updateTelegramReplicaMetadata(env, fileId, patch) {
    const db = getDatabase(env);
    const record = await db.getWithMetadata(fileId);
    if (!record) return;

    const metadata = record.metadata || {};
    const replicas = metadata.Replicas && typeof metadata.Replicas === 'object'
        ? { ...metadata.Replicas }
        : {};

    replicas.telegram = {
        ...(replicas.telegram || {}),
        ...patch,
        updatedAt: Date.now(),
    };

    const updatedMetadata = {
        ...metadata,
        Replicas: replicas,
    };

    await db.put(fileId, record.value ?? '', { metadata: updatedMetadata });
}

function selectTelegramBackupChannel(uploadConfig, env) {
    const channels = uploadConfig?.telegram?.channels || [];
    if (channels.length === 0) return null;

    const preferredName = env.TG_BACKUP_CHANNEL_NAME;
    if (preferredName) {
        const preferred = channels.find(channel => channel.name === preferredName);
        if (preferred) return preferred;
    }
    return channels[0];
}

async function sendTelegramDocumentWithRetry(api, chatId, blob, fileName, caption, maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await api.sendFile(blob, chatId, 'sendDocument', 'document', caption, fileName);
            const info = api.getFileInfo(response);
            if (!info?.file_id) {
                throw new Error('Telegram did not return a document file_id');
            }
            return {
                fileId: info.file_id,
                fileName: info.file_name || fileName,
                size: Number(info.file_size) || Number(blob.size) || 0,
            };
        } catch (error) {
            lastError = error;
            if (attempt < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, Math.min(500 * (2 ** (attempt - 1)), 2000)));
            }
        }
    }
    throw lastError || new Error('Telegram backup failed');
}

async function uploadFileAsTelegramBackup(file, channel, originalFileName) {
    const api = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
    const chatId = channel.chatId;
    const fileName = originalFileName || file.name || 'backup.bin';
    const fileSize = Number(file.size) || 0;
    const totalChunks = Math.max(1, Math.ceil(fileSize / TELEGRAM_BACKUP_CHUNK_SIZE));

    if (totalChunks > TELEGRAM_BACKUP_MAX_CHUNKS) {
        throw new Error(`Telegram backup exceeds ${TELEGRAM_BACKUP_MAX_CHUNKS} x 16MB chunk safety limit`);
    }

    if (totalChunks === 1) {
        const uploaded = await sendTelegramDocumentWithRetry(
            api,
            chatId,
            file,
            fileName,
            'ImgBed backup'
        );
        return {
            chunked: false,
            fileId: uploaded.fileId,
            sizeBytes: uploaded.size,
        };
    }

    const chunks = [];
    for (let index = 0; index < totalChunks; index++) {
        const start = index * TELEGRAM_BACKUP_CHUNK_SIZE;
        const end = Math.min(start + TELEGRAM_BACKUP_CHUNK_SIZE, fileSize);
        const chunk = file.slice(start, end);
        const chunkName = `${fileName}.part${String(index).padStart(3, '0')}`;
        const uploaded = await sendTelegramDocumentWithRetry(
            api,
            chatId,
            chunk,
            chunkName,
            `ImgBed backup ${index + 1}/${totalChunks}`
        );
        chunks.push({
            index,
            fileId: uploaded.fileId,
            size: uploaded.size,
            fileName: chunkName,
        });
    }

    return {
        chunked: true,
        totalChunks,
        sizeBytes: fileSize,
        chunks,
    };
}

async function loadBackupSourceFile(context, backupRequest, fileId, primaryChannel) {
    try {
        const formdata = await backupRequest.clone().formData();
        const file = formdata.get('file');
        if (file && typeof file.arrayBuffer === 'function') {
            return file;
        }
    } catch {
        // Merge requests intentionally have no file body. Fall through to the
        // primary backend so chunked R2 uploads can still receive a TG backup.
    }

    if (normalizePrimaryChannel(primaryChannel) === 'cfr2' && context.env.img_r2) {
        const object = await context.env.img_r2.get(fileId);
        if (!object) return null;
        const contentType = object.httpMetadata?.contentType || 'application/octet-stream';
        const bytes = await object.arrayBuffer();
        return new File([bytes], fileId.split('/').pop() || 'backup.bin', { type: contentType });
    }

    return null;
}

/**
 * Background Telegram replica. The primary metadata (Channel / ChannelName) is
 * never changed; replica information is kept under metadata.Replicas.telegram.
 */
export async function backupSuccessfulUploadToTelegram(context, backupRequest, uploadResponse, primaryChannel) {
    if (!uploadResponse?.ok) return;

    const fileId = await extractFileId(uploadResponse);
    if (!fileId) return;

    const normalizedPrimary = normalizePrimaryChannel(primaryChannel);
    if (normalizedPrimary === 'telegram' || normalizedPrimary === 'external') return;

    const uploadConfig = await fetchUploadConfig(context.env, context);
    const tgChannel = selectTelegramBackupChannel(uploadConfig, context.env);
    if (!tgChannel?.botToken || !tgChannel?.chatId) {
        await updateTelegramReplicaMetadata(context.env, fileId, {
            status: 'not_configured',
            primaryChannel: normalizedPrimary,
        });
        return;
    }

    await updateTelegramReplicaMetadata(context.env, fileId, {
        status: 'pending',
        channelName: tgChannel.name,
        primaryChannel: normalizedPrimary,
        lastError: null,
    });

    try {
        const sourceFile = await loadBackupSourceFile(context, backupRequest, fileId, normalizedPrimary);
        if (!sourceFile) {
            throw new Error(`Unable to load source bytes for primary channel: ${normalizedPrimary}`);
        }

        const result = await uploadFileAsTelegramBackup(
            sourceFile,
            tgChannel,
            sourceFile.name || fileId.split('/').pop()
        );

        await updateTelegramReplicaMetadata(context.env, fileId, {
            status: 'ready',
            channelName: tgChannel.name,
            primaryChannel: normalizedPrimary,
            backedUpAt: Date.now(),
            lastError: null,
            ...result,
        });
    } catch (error) {
        console.error(`Telegram backup failed for ${fileId}:`, error.message);
        await updateTelegramReplicaMetadata(context.env, fileId, {
            status: 'failed',
            channelName: tgChannel.name,
            primaryChannel: normalizedPrimary,
            lastError: String(error.message || error).slice(0, 500),
        });
    }
}
