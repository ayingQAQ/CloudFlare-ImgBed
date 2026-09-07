import { fetchUploadConfig } from './sysConfig.js';
import { getIndexMeta, addFileToIndex } from './indexManager.js';
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
    } catch (error) {
        console.warn('Storage tiering: failed to estimate upload size:', error.message);
    }

    return 0;
}

function calculateR2UsedBytes(indexMeta, r2Channels) {
    const channelStats = indexMeta?.channelStats || {};
    const r2Names = new Set((r2Channels || []).map(channel => channel?.name).filter(Boolean));
    r2Names.add('R2_env');

    let usedMB = 0;
    for (const [channelName, stats] of Object.entries(channelStats)) {
        if (r2Names.has(channelName)) {
            usedMB += Number(stats?.usedMB) || 0;
        }
    }
    return usedMB * BINARY_MB;
}

export async function resolveAutomaticPrimary(context, request = context.request) {
    const { env } = context;
    const url = new URL(request.url);
    const uploadConfig = await fetchUploadConfig(env, context);
    const r2Channels = uploadConfig?.cfr2?.channels || [];
    const hfChannels = uploadConfig?.huggingface?.channels || [];
    const hasR2 = Boolean(env.img_r2) && r2Channels.length > 0;
    const hasHF = hfChannels.length > 0;

    if (!hasR2 && hasHF) {
        return { channel: 'huggingface', reason: 'r2_unavailable', r2UsagePercent: null };
    }

    if (!hasR2 && !hasHF) {
        return { channel: null, reason: 'no_primary_storage', r2UsagePercent: null };
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
            usageSource: 'imgbed_index',
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
            usageSource: 'imgbed_index',
        };
    }

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
        usageSource: 'imgbed_index',
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

async function updateTelegramReplicaMetadata(context, fileId, patch) {
    const db = getDatabase(context.env);
    const record = await db.getWithMetadata(fileId);
    if (!record) return null;

    const metadata = record.metadata || {};
    const replicas = metadata.Replicas && typeof metadata.Replicas === 'object'
        ? { ...metadata.Replicas }
        : {};

    replicas.telegram = {
        ...(replicas.telegram || {}),
        ...patch,
        updatedAt: Date.now(),
    };

    const updatedMetadata = { ...metadata, Replicas: replicas };
    await db.put(fileId, record.value ?? '', { metadata: updatedMetadata });

    if (patch.status === 'ready' || patch.status === 'failed' || patch.status === 'not_configured') {
        await addFileToIndex(context, fileId, updatedMetadata);
    }

    return updatedMetadata;
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

function encodePath(path) {
    return String(path || '')
        .split('/')
        .map(part => encodeURIComponent(part))
        .join('/');
}

function selectHuggingFaceChannel(uploadConfig, channelName) {
    const channels = uploadConfig?.huggingface?.channels || [];
    return channels.find(channel => channel.name === channelName) || channels[0] || null;
}

async function createPrimarySource(context, fileId, primaryChannel, uploadConfig) {
    const normalizedPrimary = normalizePrimaryChannel(primaryChannel);
    const db = getDatabase(context.env);
    const record = await db.getWithMetadata(fileId);
    const metadata = record?.metadata || {};
    const fileName = metadata.FileName || fileId.split('/').pop() || 'backup.bin';
    const contentType = metadata.FileType || 'application/octet-stream';

    if (normalizedPrimary === 'cfr2' && context.env.img_r2) {
        const head = await context.env.img_r2.head(fileId);
        if (!head) return null;

        const size = Number(head.size) || Number(metadata.FileSizeBytes) || 0;
        return {
            size,
            fileName,
            contentType: head.httpMetadata?.contentType || contentType,
            async readSlice(start, end) {
                const object = await context.env.img_r2.get(fileId, {
                    range: { offset: start, length: end - start },
                });
                if (!object) throw new Error('R2 source object disappeared during Telegram backup');
                const bytes = await object.arrayBuffer();
                return new Blob([bytes], { type: head.httpMetadata?.contentType || contentType });
            },
        };
    }

    if (normalizedPrimary === 'huggingface') {
        const hfPath = metadata.HfFilePath;
        const hfChannel = selectHuggingFaceChannel(uploadConfig, metadata.ChannelName);
        if (!hfPath || !hfChannel?.repo || !hfChannel?.token) return null;

        const repo = hfChannel.repo.split('/').map(encodeURIComponent).join('/');
        const fileUrl = `https://huggingface.co/datasets/${repo}/resolve/main/${encodePath(hfPath)}`;
        let size = Number(metadata.FileSizeBytes) || 0;

        if (!size) {
            const headResponse = await fetch(fileUrl, {
                method: 'HEAD',
                headers: { Authorization: `Bearer ${hfChannel.token}` },
            });
            if (!headResponse.ok) {
                throw new Error(`Unable to read Hugging Face backup source metadata: ${headResponse.status}`);
            }
            size = Number(headResponse.headers.get('content-length')) || 0;
        }

        return {
            size,
            fileName,
            contentType,
            async readSlice(start, end) {
                const headers = {
                    Authorization: `Bearer ${hfChannel.token}`,
                    Range: `bytes=${start}-${end - 1}`,
                };
                const response = await fetch(fileUrl, { headers });
                const isWholeFileRequest = start === 0 && end >= size;
                if (!response.ok || (!isWholeFileRequest && response.status !== 206)) {
                    throw new Error(`Hugging Face range read failed: ${response.status}`);
                }
                return await response.blob();
            },
        };
    }

    return null;
}

async function sendTelegramDocumentWithRetry(api, chatId, blob, fileName, caption, maxAttempts = 3) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await api.sendFile(blob, chatId, 'sendDocument', 'document', caption, fileName);
            const info = api.getFileInfo(response);
            if (!info?.file_id) throw new Error('Telegram did not return a document file_id');
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

async function uploadPrimarySourceToTelegram(source, channel) {
    const api = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
    const chatId = channel.chatId;
    const fileSize = Number(source.size) || 0;
    const totalChunks = Math.max(1, Math.ceil(fileSize / TELEGRAM_BACKUP_CHUNK_SIZE));

    if (totalChunks > TELEGRAM_BACKUP_MAX_CHUNKS) {
        throw new Error(`Telegram backup exceeds ${TELEGRAM_BACKUP_MAX_CHUNKS} x 16MB chunk safety limit`);
    }

    if (totalChunks === 1) {
        const blob = await source.readSlice(0, fileSize);
        const uploaded = await sendTelegramDocumentWithRetry(
            api,
            chatId,
            blob,
            source.fileName,
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
        const blob = await source.readSlice(start, end);
        const chunkName = `${source.fileName}.part${String(index).padStart(3, '0')}`;
        const uploaded = await sendTelegramDocumentWithRetry(
            api,
            chatId,
            blob,
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

export async function backupFileIdToTelegram(context, fileId, primaryChannel) {
    const normalizedPrimary = normalizePrimaryChannel(primaryChannel);
    if (!fileId || normalizedPrimary === 'telegram' || normalizedPrimary === 'external' || !normalizedPrimary) return;

    const uploadConfig = await fetchUploadConfig(context.env, context);
    const tgChannel = selectTelegramBackupChannel(uploadConfig, context.env);
    if (!tgChannel?.botToken || !tgChannel?.chatId) {
        await updateTelegramReplicaMetadata(context, fileId, {
            status: 'not_configured',
            primaryChannel: normalizedPrimary,
        });
        return;
    }

    await updateTelegramReplicaMetadata(context, fileId, {
        status: 'pending',
        channelName: tgChannel.name,
        primaryChannel: normalizedPrimary,
        lastError: null,
    });

    try {
        const source = await createPrimarySource(context, fileId, normalizedPrimary, uploadConfig);
        if (!source || !Number.isFinite(Number(source.size)) || Number(source.size) < 0) {
            throw new Error(`Unable to load source bytes for primary channel: ${normalizedPrimary}`);
        }

        const result = await uploadPrimarySourceToTelegram(source, tgChannel);
        await updateTelegramReplicaMetadata(context, fileId, {
            status: 'ready',
            channelName: tgChannel.name,
            primaryChannel: normalizedPrimary,
            backedUpAt: Date.now(),
            lastError: null,
            ...result,
        });
    } catch (error) {
        console.error(`Telegram backup failed for ${fileId}:`, error.message);
        await updateTelegramReplicaMetadata(context, fileId, {
            status: 'failed',
            channelName: tgChannel.name,
            primaryChannel: normalizedPrimary,
            lastError: String(error.message || error).slice(0, 500),
        });
    }
}
