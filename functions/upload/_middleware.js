import { errorHandling, telemetryData, checkDatabaseConfig } from '../utils/middleware';
import { refreshTieringIndex } from '../utils/tieringIndex.js';
import {
    resolveAutomaticPrimary,
    isAutomaticChannelRequest,
    shouldScheduleTelegramBackup,
    resolveEffectivePrimaryForRequest,
    extractUploadedFileId,
    backupFileIdToTelegram,
} from '../utils/storageTiering.js';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

async function handleOptions(context) {
    if (context.request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders,
        });
    }
    return context.next();
}

/**
 * Automatic storage tiering for the main /upload endpoint only.
 *
 * Default policy:
 * - automatic uploads prefer R2
 * - when projected managed R2 usage reaches the safety threshold (95% by default), use Hugging Face
 * - Telegram is never selected as a primary by this policy; it is an asynchronous replica
 *
 * Explicit uploadChannel requests keep the upstream project's behavior.
 */
async function storageTiering(context) {
    const originalRequest = context.request;
    const originalUrl = new URL(originalRequest.url);
    const normalizedPath = originalUrl.pathname.replace(/\/+$/, '') || '/';

    // This middleware also wraps /upload/huggingface/* in Pages/Worker deployments.
    // Do not reinterpret the dedicated Hugging Face helper endpoints as normal uploads.
    if (normalizedPath !== '/upload' || originalRequest.method !== 'POST') {
        return context.next();
    }

    if (originalUrl.searchParams.get('cleanup') === 'true') {
        return context.next();
    }

    const isChunked = originalUrl.searchParams.get('chunked') === 'true';
    const isMerge = originalUrl.searchParams.get('merge') === 'true';
    const isInitChunked = originalUrl.searchParams.get('initChunked') === 'true';
    const isChunkPart = isChunked && !isMerge;

    let downstreamRequest = originalRequest;
    let downstreamUrl = originalUrl;
    const automaticRequest = isAutomaticChannelRequest(originalUrl);

    // Chunk parts and merge requests must keep the channel chosen by the upload session.
    if (automaticRequest && !isChunkPart && !isMerge) {
        await refreshTieringIndex(context);
        const decision = await resolveAutomaticPrimary(context, originalRequest);

        if (!decision.channel) {
            const details = {
                success: false,
                error: decision.reason,
                message: decision.reason === 'r2_threshold_reached_hf_unavailable'
                    ? 'R2 已达到安全阈值，但 Hugging Face 未配置或不可用。请配置 Hugging Face，或显式选择 R2 后重试。'
                    : '没有可用的主存储渠道，请至少配置 R2 或 Hugging Face。',
                tiering: decision,
            };
            return new Response(JSON.stringify(details), {
                status: 503,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json',
                },
            });
        }

        // The existing chunk uploader cannot switch an initialized multipart session
        // to Hugging Face. Fail before creating a partial session; the frontend can
        // then use the existing HF direct/LFS flow.
        if (isInitChunked && decision.channel === 'huggingface') {
            return new Response(JSON.stringify({
                success: false,
                error: 'hf_direct_upload_required',
                message: 'R2 已达到安全阈值，大文件请改用 Hugging Face 直传流程。',
                tiering: decision,
            }), {
                status: 409,
                headers: {
                    ...corsHeaders,
                    'Content-Type': 'application/json',
                },
            });
        }

        downstreamUrl = new URL(originalUrl);
        downstreamUrl.searchParams.set('uploadChannel', decision.channel);
        downstreamUrl.searchParams.delete('channelName');

        // The upstream retry list includes Telegram/S3/etc. In automatic tiered mode
        // those must never silently become the primary, otherwise TG would stop being
        // a backup-only backend. Capacity switching is handled here instead.
        downstreamUrl.searchParams.set('autoRetry', 'false');

        downstreamRequest = new Request(downstreamUrl.toString(), originalRequest);
        context.storageTieringDecision = decision;
    }

    const effectivePrimary = await resolveEffectivePrimaryForRequest(
        context,
        downstreamRequest,
        downstreamUrl.searchParams.get('uploadChannel') || ''
    );

    // Passing the rewritten Request through next() is the documented Pages Functions
    // mechanism; mutating context.request is not relied upon.
    const response = await context.next(downstreamRequest);

    const isFinalUpload = !isInitChunked && !isChunkPart;
    if (
        isFinalUpload &&
        response.ok &&
        shouldScheduleTelegramBackup(effectivePrimary, downstreamUrl)
    ) {
        const fileId = await extractUploadedFileId(response.clone());
        if (fileId) {
            context.waitUntil(backupFileIdToTelegram(context, fileId, effectivePrimary));
        }
    }

    return response;
}

export const onRequest = [
    checkDatabaseConfig,
    handleOptions,
    errorHandling,
    storageTiering,
    telemetryData,
];
