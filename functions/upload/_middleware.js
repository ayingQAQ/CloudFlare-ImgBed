import { errorHandling, telemetryData, checkDatabaseConfig } from '../utils/middleware';
import { refreshTieringIndex } from '../utils/tieringIndex.js';
import {
    resolveAutomaticPrimary,
    isAutomaticChannelRequest,
    shouldScheduleTelegramBackup,
    resolveEffectivePrimaryForRequest,
    backupSuccessfulUploadToTelegram,
} from '../utils/storageTiering.js';

// CORS 跨域响应头
const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

// OPTIONS 预检请求处理
async function handleOptions(context) {
    if (context.request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders
        });
    }
    return context.next();
}

/**
 * 自动存储分层：
 * - 未显式指定 uploadChannel（或 uploadChannel=auto）时，默认使用 R2
 * - R2 托管容量预计达到阈值（默认 10GB 的 95%）时切换 Hugging Face
 * - 主上传成功后异步备份一份到 Telegram
 *
 * 显式指定渠道时保持原项目行为，不强制改写用户选择。
 */
async function storageTiering(context) {
    let request = context.request;
    let url = new URL(request.url);

    if (request.method !== 'POST') {
        return context.next();
    }

    // 清理请求不是最终文件上传，不进入自动分层/备份。
    if (url.searchParams.get('cleanup') === 'true') {
        return context.next();
    }

    // 备份任务需要在下游消费请求体之前保留一个副本。
    // 分块 merge 请求本身不含完整文件，备份服务会在需要时从主存储读取。
    const backupRequest = request.clone();

    const isChunked = url.searchParams.get('chunked') === 'true';
    const isMerge = url.searchParams.get('merge') === 'true';
    const isInitChunked = url.searchParams.get('initChunked') === 'true';
    const isChunkPart = isChunked && !isMerge;

    // 分块续传和 merge 必须沿用初始化会话的存储渠道，不能中途切换。
    if (isAutomaticChannelRequest(url) && !isChunkPart && !isMerge) {
        // 先合并上一次上传留下的索引操作，确保 R2 容量统计尽量实时。
        await refreshTieringIndex(context);

        const decision = await resolveAutomaticPrimary(context, request);

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

        // 旧版前端的大文件分块器只支持 R2/S3/TG/Discord，不能直接把
        // 已经初始化为分块上传的请求切到 Hugging Face。此时返回明确错误，
        // 避免部分文件落在错误渠道；前端后续可据此切换 HF 直传流程。
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

        url.searchParams.set('uploadChannel', decision.channel);
        url.searchParams.delete('channelName');

        request = new Request(url.toString(), request);
        context.request = request;
        context.url = new URL(request.url);
        context.storageTieringDecision = decision;
    }

    const effectivePrimary = await resolveEffectivePrimaryForRequest(
        context,
        request,
        url.searchParams.get('uploadChannel') || ''
    );

    const response = await context.next();

    // 初始化和单个分块不是完整文件，不触发 TG 备份；merge 成功后可以触发。
    const isFinalUpload = !isInitChunked && !isChunkPart;
    if (
        isFinalUpload &&
        response.ok &&
        shouldScheduleTelegramBackup(effectivePrimary, url)
    ) {
        context.waitUntil(
            backupSuccessfulUploadToTelegram(
                context,
                backupRequest,
                response.clone(),
                effectivePrimary
            )
        );
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
