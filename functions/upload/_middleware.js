import { errorHandling, telemetryData, checkDatabaseConfig } from '../utils/middleware';
import { releaseR2, checkR2Reservation } from '../utils/r2Capacity.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { userAuthCheck, UnauthorizedResponse } from '../utils/auth/userAuth.js';
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
 * - normal R2 uploads participate in automatic R2 -> Hugging Face tiering
 * - when projected managed R2 usage reaches the safety threshold (95% by default), use Hugging Face
 * - Telegram is never selected as a primary by this policy; it is an asynchronous replica
 * - API clients can bypass tiering deliberately with ?tiering=off or ?forcePrimary=true
 */
async function storageTiering(context) {
    const originalRequest = context.request;
    const originalUrl = new URL(originalRequest.url);
    const normalizedPath = originalUrl.pathname.replace(/\/+$/, '') || '/';

    // This middleware also wraps /upload/huggingface/* in Pages/Worker deployments.
    // Do not reinterpret the dedicated Hugging Face helper endpoints as normal uploads.
    const cleanup = originalUrl.searchParams.get('cleanup') === 'true';
    if (normalizedPath !== '/upload' || (originalRequest.method !== 'POST' && !cleanup)) {
        return context.next();
    }

    // Capacity reservations are writes; authenticate before allocating them.
    if (!await userAuthCheck(context.env, originalUrl, originalRequest, 'upload')) {
        return UnauthorizedResponse('Unauthorized');
    }
    if (cleanup) {
        const session = JSON.parse(await getDatabase(context.env).get(`upload_session_${originalUrl.searchParams.get('uploadId')}`) || 'null');
        const response = await context.next();
        if (response.ok) await releaseR2(context.env.img_r2, session?.tieringReservation);
        return response;
    }

    const isChunked = originalUrl.searchParams.get('chunked') === 'true';
    const isMerge = originalUrl.searchParams.get('merge') === 'true';
    const isInitChunked = originalUrl.searchParams.get('initChunked') === 'true';
    const isChunkPart = isChunked && !isMerge;

    let downstreamRequest = originalRequest;
    let downstreamUrl = originalUrl;
    const automaticRequest = isAutomaticChannelRequest(originalUrl);
    let reservationId;
    if (isChunkPart || isMerge) {
        const form = await originalRequest.clone().formData();
        const session = JSON.parse(await getDatabase(context.env).get(`upload_session_${form.get('uploadId')}`) || 'null');
        if (session?.tieringReservation) {
            reservationId = session.tieringReservation;
            const reserved = await checkR2Reservation(context.env.img_r2, reservationId);
            if (Date.now() > session.expiresAt) return new Response('Upload session expired', { status: 410 });
            const chunk = form.get('file');
            const index = Number(form.get('chunkIndex'));
            if (isChunkPart && (!Number.isInteger(index) || index < 0 || index >= session.totalChunks ||
                !chunk || chunk.size > 16 * 1024 * 1024 ||
                index * 16 * 1024 * 1024 + chunk.size > reserved.bytes)) {
                return new Response('Chunk exceeds reserved capacity', { status: 400 });
            }
            downstreamUrl = new URL(originalUrl);
            downstreamUrl.searchParams.set('uploadChannel', session.uploadChannel);
            downstreamUrl.searchParams.set('autoRetry', 'false');
            downstreamUrl.searchParams.set('tieringReservation', reservationId);
            downstreamRequest = new Request(downstreamUrl, originalRequest);
        }
    }

    // Chunk parts and merge requests must keep the channel chosen by the upload session.
    if (automaticRequest && !isChunkPart && !isMerge) {
        const decision = await resolveAutomaticPrimary(context, originalRequest);
        reservationId = decision.reservationId;

        if (!decision.channel) {
            const details = {
                success: false,
                error: decision.reason,
                message: decision.reason === 'r2_threshold_reached_hf_unavailable'
                    ? 'R2 已达到安全阈值，但 Hugging Face 未配置或不可用。请配置 Hugging Face；如确需强制写入 R2，API 请求可显式使用 tiering=off。'
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
        downstreamUrl.searchParams.delete('tieringReservation');
        if (reservationId && isInitChunked) downstreamUrl.searchParams.set('tieringReservation', reservationId);

        downstreamRequest = new Request(downstreamUrl.toString(), originalRequest);
        context.storageTieringDecision = decision;
    }

    // HF can also be selected directly by the UI. Its failures must not fall back
    // to a full R2 bucket or promote Telegram to primary storage.
    if (downstreamUrl.searchParams.get('uploadChannel') === 'huggingface') {
        downstreamUrl = new URL(downstreamUrl);
        downstreamUrl.searchParams.set('autoRetry', 'false');
        downstreamRequest = new Request(downstreamUrl, downstreamRequest);
    }

    const effectivePrimary = await resolveEffectivePrimaryForRequest(
        context,
        downstreamRequest,
        downstreamUrl.searchParams.get('uploadChannel') || ''
    );

    // Passing the rewritten Request through next() is the documented Pages Functions
    // mechanism; mutating context.request is not relied upon.
    let response;
    try {
        response = await context.next(downstreamRequest);
    } finally {
        // A successful init keeps capacity until merge; failed parts can be retried.
        if (reservationId && ((!isChunkPart && !isInitChunked) || (isInitChunked && !response?.ok))) {
            await releaseR2(context.env.img_r2, reservationId);
        }
    }

    const isFinalUpload = !isInitChunked && !isChunkPart;
    if (
        isFinalUpload &&
        response.ok &&
        shouldScheduleTelegramBackup(effectivePrimary, downstreamUrl)
    ) {
        const fileId = await extractUploadedFileId(response.clone());
        if (fileId) {
            // Persist the job before acknowledging success. Processing is resumable.
            await backupFileIdToTelegram(context, fileId, effectivePrimary);
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
