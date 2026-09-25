import { registerMultipartRecovery, finishMultipartRecovery } from '../utils/multipartRecovery.js';
import { claimChunkAttempt } from './chunkAttempt.js';
import { getUploadForm, CHUNK_BYTES, uploadMap, uploadDelay } from './uploadRequest.js';
/* ======= 客户端分块上传处理 ======= */
import { createResponse, selectConsistentChannel, getUploadIp, getIPAddress, buildUniqueFileId, endUpload } from './uploadTools';
import { TelegramAPI } from '../utils/storage/telegramAPI';
import { DiscordAPI } from '../utils/storage/discordAPI';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";
import { getDatabase, checkDatabaseConfig } from '../utils/databaseAdapter.js';
import { fetchPageConfig } from '../utils/sysConfig.js';
import { attachR2Multipart, chargeR2Usage, releaseR2 } from '../utils/r2Capacity.js';

// 初始化分块上传
export async function initializeChunkedUpload(context) {
    const { request, env, url } = context;
    const db = getDatabase(env);
    let createdReservation;

    try {
        // 解析表单数据
        const formdata = await getUploadForm(context);

        const originalFileName = formdata.get('originalFileName');
        const originalFileType = formdata.get('originalFileType');
        const totalChunks = parseInt(formdata.get('totalChunks'));

        if (!originalFileName || !originalFileType || !Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > 10000) {
            return createResponse('Error: Missing initialization parameters', { status: 400 });
        }

        // 生成唯一的 uploadId
        const timestamp = Date.now();
        const random = Math.random().toString(36).slice(2, 11);
        const uploadId = `upload_${timestamp}_${random}`;

        // 获取上传IP
        const uploadIp = getUploadIp(request);
        const ipAddress = await getIPAddress(env, uploadIp, context.securityConfig);

        // 获取上传渠道
        const uploadChannel = url.searchParams.get('uploadChannel') || 'telegram';
        if (uploadChannel === 'webdav') {
            return createResponse('Error: WebDAV channel does not support chunked uploads. Please use non-chunked upload within your Cloudflare request body limit.', { status: 400 });
        }
        // 获取指定的渠道名称
        const channelName = url.searchParams.get('channelName') || '';

        context.data ||= {};
        let tieringReservation = context.data.r2Reservation;
        if (uploadChannel === 'cfr2' && !tieringReservation) {
            tieringReservation = await chargeR2Usage(env.img_r2, totalChunks * CHUNK_BYTES);
            createdReservation = tieringReservation;
            context.data.r2Reservation = tieringReservation;
        }
        // 存储上传会话信息
        const sessionInfo = {
            uploadId,
            originalFileName,
            originalFileType,
            totalChunks,
            uploadChannel,
            channelName,
            tieringReservation: tieringReservation || undefined,
            anonymousReservation: url.searchParams.get('anonymousReservation') || undefined,
            uploadFolder: url.searchParams.get('uploadFolder') || '',
            uploadIp,
            ipAddress,
            status: 'initialized',
            createdAt: timestamp,
            expiresAt: timestamp + 3600000 // 1小时过期
        };

        // 保存会话信息
        const sessionKey = `upload_session_${uploadId}`;
        await db.put(sessionKey, JSON.stringify(sessionInfo), {
            expirationTtl: 3600 // 1小时过期
        });

        return createResponse(JSON.stringify({
            success: true,
            uploadId,
            message: 'Chunked upload initialized successfully',
            sessionInfo: {
                uploadId,
                originalFileName,
                totalChunks,
                uploadChannel,
                channelName
            }
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        if (createdReservation) await releaseR2(env.img_r2, createdReservation);
        return createResponse(`Error: Failed to initialize chunked upload - ${error.message}`, { status: error.status || 500 });
    }
}

// 处理客户端分块上传
export async function handleChunkUpload(context) {
    const { env, request, url, waitUntil } = context;
    const db = getDatabase(env);

    // 解析表单数据
    const formdata = await getUploadForm(context);
    context.formdata = formdata;

    try {
        const chunk = formdata.get('file');
        const chunkIndex = parseInt(formdata.get('chunkIndex'));
        const totalChunks = parseInt(formdata.get('totalChunks'));
        const uploadId = formdata.get('uploadId');
        const originalFileName = formdata.get('originalFileName');
        const originalFileType = formdata.get('originalFileType');

        if (!chunk || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks || !totalChunks || !uploadId || !originalFileName || !originalFileType) {
            return createResponse('Error: Missing chunk upload parameters', { status: 400 });
        }

        // 验证上传会话
        const sessionKey = `upload_session_${uploadId}`;
        const sessionData = await db.get(sessionKey);
        if (!sessionData) {
            return createResponse('Error: Invalid or expired upload session', { status: 400 });
        }

        const sessionInfo = JSON.parse(sessionData);

        // 验证会话信息
        if (sessionInfo.originalFileName !== originalFileName ||
            sessionInfo.totalChunks !== totalChunks) {
            return createResponse('Error: Session parameters mismatch', { status: 400 });
        }

        // 检查会话是否过期
        if (Date.now() > sessionInfo.expiresAt) {
            return createResponse('Error: Upload session expired', { status: 410 });
        }

        // 获取上传渠道
        const uploadChannel = url.searchParams.get('uploadChannel') || sessionInfo.uploadChannel || 'telegram';
        if (uploadChannel === 'webdav') {
            return createResponse('Error: WebDAV channel does not support chunked uploads. Please use non-chunked upload within your Cloudflare request body limit.', { status: 400 });
        }
        // 获取指定的渠道名称
        const channelName = url.searchParams.get('channelName') || sessionInfo.channelName || '';

        // 将渠道名称存入 context
        context.specifiedChannelName = channelName;

        // 立即创建分块记录，标记为"uploading"状态
        const chunkKey = `chunk_${uploadId}_${chunkIndex.toString().padStart(3, '0')}`;
        if (chunk.size > CHUNK_BYTES) return createResponse('Chunk exceeds size limit', { status: 413 });
        const chunkData = await chunk.arrayBuffer();
        const uploadStartTime = Date.now();
        const initialChunkMetadata = {
            uploadId,
            chunkIndex,
            totalChunks,
            originalFileName,
            originalFileType,
            chunkSize: chunkData.byteLength,
            uploadTime: uploadStartTime,
            uploadStartTime: uploadStartTime,
            status: 'uploading',
            uploadChannel,
            timeoutThreshold: uploadStartTime + 180000 // 1分钟超时阈值
        };

        await uploadChunkToStorageWithTimeout(context, chunkIndex, totalChunks, uploadId,
            originalFileName, originalFileType, uploadChannel, chunkData, initialChunkMetadata);

        return createResponse(JSON.stringify({
            success: true,
            message: `Chunk ${chunkIndex + 1}/${totalChunks} received and being uploaded`,
            uploadId,
            chunkIndex
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        return createResponse(JSON.stringify({ success: false, retryable: !error.restartUpload, resendChunk: !error.restartUpload, restartUpload: !!error.restartUpload, error: error.message }), { status: error.status || 503, headers: { 'Content-Type': 'application/json' } });
    }
}

// 处理清理请求
export async function handleCleanupRequest(context, uploadId, totalChunks) {
    try {
        if (!uploadId) {
            return createResponse(JSON.stringify({
                error: 'Missing uploadId parameter'
            }), { status: 400, headers: { 'Content-Type': 'application/json' } });
        }

        // 强制清理所有相关数据
        await forceCleanupUpload(context, uploadId, totalChunks);

        return createResponse(JSON.stringify({
            success: true,
            message: `Cleanup completed for upload ${uploadId}`,
            uploadId: uploadId,
            cleanedChunks: totalChunks
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        return createResponse(JSON.stringify({
            error: `Cleanup failed: ${error.message}`,
            uploadId: uploadId
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}

/* ======= 单个分块上传到不同渠道的存储端 ======= */

// 带超时保护的异步上传分块到存储端
export async function uploadChunkToStorageWithTimeout(context, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType, uploadChannel, chunkData, initialMetadata) {
    const db = getDatabase(context.env);
    const key = `chunk_${uploadId}_${String(chunkIndex).padStart(3, '0')}`;
    const attempt = await claimChunkAttempt(context.env, uploadId, chunkIndex, context.uploadTimeoutMs ?? 180000);
    const controller = new AbortController();
    const onAbort = () => controller.abort(context.request.signal.reason);
    if (context.request?.signal?.aborted) onAbort();
    else context.request?.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Upload timeout')), context.uploadTimeoutMs ?? 180000);
    const uploadContext = { ...context, uploadSignal: controller.signal };
    const { usingD1 } = checkDatabaseConfig(context.env);
    let record;
    try {
        record = await db.getWithMetadata(key, { type: 'arrayBuffer' });
        const session = JSON.parse(await db.get(`upload_session_${uploadId}`) || 'null');
        if (!session || session.expiresAt <= Date.now()) throw Object.assign(new Error('Upload session expired'), { status: 410, restartUpload: true });
        if (record?.metadata?.status === 'completed') return;
        if (initialMetadata) {
            await attempt.assertOwner();
            await db.put(key, usingD1 ? '' : chunkData, { metadata: initialMetadata, expirationTtl: 3600 });
            record = { metadata: initialMetadata };
        }
        chunkData ??= record?.value;
        if (!chunkData?.byteLength) throw new Error('Original chunk must be resent by the client');
        const upload = { cfr2: uploadSingleChunkToR2Multipart, s3: uploadSingleChunkToS3Multipart,
            telegram: uploadSingleChunkToTelegram, discord: uploadSingleChunkToDiscord }[uploadChannel];
        if (!upload) throw new Error('Unsupported chunk channel');
        let result;
        for (let retry = 0; retry < 3; retry++) {
            controller.signal.throwIfAborted();
            // Await even non-cancellable R2 RPCs. Never detach a write on timeout.
            result = await upload(uploadContext, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType);
            controller.signal.throwIfAborted();
            if (result?.success) break;
        }
        if (!result?.success) throw new Error(result?.error || 'Chunk storage failed');
        await attempt.assertOwner();
        await db.put(key, '', { metadata: { ...record?.metadata, status: 'completed', uploadResult: result, completedTime: Date.now() }, expirationTtl: 3600 });
        controller.signal.throwIfAborted();
    } catch (error) {
        await attempt.assertOwner();
        await db.put(key, usingD1 ? '' : chunkData || '', { metadata: { ...record?.metadata,
            status: controller.signal.aborted ? 'timeout' : 'failed', error: error.message,
            resendChunk: usingD1, failedTime: Date.now() }, expirationTtl: 3600 });
        throw error;
    } finally {
        clearTimeout(timer);
        context.request?.signal?.removeEventListener('abort', onAbort);
        await attempt.release();
    }
}

// 上传单个分块到R2 (Multipart Upload)
async function uploadSingleChunkToR2Multipart(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType) {
    const { env, uploadConfig } = context;
    const db = getDatabase(env);

    try {
        const r2Settings = uploadConfig.cfr2;
        if (!r2Settings.channels || r2Settings.channels.length === 0) {
            return { success: false, error: 'No R2 channel provided' };
        }

        const R2DataBase = env.img_r2;
        const multipartKey = `multipart_${uploadId}`;

        let finalFileId;

        // 如果是第一个分块，生成并保存 finalFileId
        if (chunkIndex === 0 && !await db.get(multipartKey)) {
            finalFileId = await buildUniqueFileId(context, originalFileName, originalFileType);

            context.uploadSignal?.throwIfAborted();
            const multipartUpload = await R2DataBase.createMultipartUpload(finalFileId);
            if (context.uploadSignal?.aborted) {
                await multipartUpload.abort();
                context.uploadSignal.throwIfAborted();
            }
            let multipartInfo = {
                uploadId: multipartUpload.uploadId,
                key: finalFileId
            };
            const session = JSON.parse(await db.get(`upload_session_${uploadId}`) || 'null');
            const reservation = session?.tieringReservation;
            if (reservation) {
                multipartInfo = await attachR2Multipart(R2DataBase, reservation, multipartInfo);
                finalFileId = multipartInfo.key;
            }

            // Persist a non-expiring recovery journal before temporary state.
            multipartInfo.provider = 'cfr2';
            multipartInfo.reservationId = reservation;
            try {
                await registerMultipartRecovery(env, uploadId, multipartInfo);
                context.uploadSignal?.throwIfAborted();
                await db.put(multipartKey, JSON.stringify(multipartInfo), { expirationTtl: 3600 });
            } catch (error) {
                await R2DataBase.resumeMultipartUpload(multipartInfo.key, multipartInfo.uploadId).abort();
                throw error;
            }
        } else {
            // 其他分块需要等待第一个分块完成multipart upload初始化
            let multipartInfoData = null;
            let retryCount = 0;
            const maxRetries = 30; // 最多等待60秒

            while (!multipartInfoData && retryCount < maxRetries) {
                multipartInfoData = await db.get(multipartKey);
                if (!multipartInfoData) {
                    // 等待2秒后重试
                    await uploadDelay(2000, context.uploadSignal);
                    retryCount++;
                    console.log(`R2 chunk ${chunkIndex} waiting for multipart initialization... (${retryCount}/${maxRetries})`);
                }
            }

            if (!multipartInfoData) {
                return { success: false, error: 'Multipart upload not initialized after waiting' };
            }

            const multipartInfo = JSON.parse(multipartInfoData);
            finalFileId = multipartInfo.key;
        }

        // 获取multipart info
        const multipartInfoData = await db.get(multipartKey);
        if (!multipartInfoData) {
            return { success: false, error: 'Multipart upload not initialized' };
        }

        const multipartInfo = JSON.parse(multipartInfoData);

        // 上传分块
        const multipartUpload = R2DataBase.resumeMultipartUpload(finalFileId, multipartInfo.uploadId);
        context.uploadSignal?.throwIfAborted();
        const uploadedPart = await multipartUpload.uploadPart(chunkIndex + 1, chunkData);

        if (!uploadedPart || !uploadedPart.etag) {
            throw new Error(`Failed to upload part ${chunkIndex + 1} to R2`);
        }

        return {
            success: true,
            partNumber: chunkIndex + 1,
            etag: uploadedPart.etag,
            size: chunkData.byteLength,
            uploadTime: Date.now(),
            multipartUploadId: multipartInfo.uploadId,
            key: finalFileId
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// 上传单个分块到S3 (Multipart Upload)
async function uploadSingleChunkToS3Multipart(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType) {
    const { env, uploadConfig, specifiedChannelName } = context;
    const db = getDatabase(env);

    try {
        const s3Settings = uploadConfig.s3;
        const s3Channels = s3Settings.channels;
        
        // 优先使用指定的渠道名称
        let s3Channel;
        if (specifiedChannelName) {
            s3Channel = s3Channels.find(ch => ch.name === specifiedChannelName);
        }
        if (!s3Channel) {
            s3Channel = selectConsistentChannel(s3Channels, uploadId, s3Settings.loadBalance.enabled);
        }

        console.log(`Uploading S3 chunk ${chunkIndex} for uploadId: ${uploadId}, selected channel: ${s3Channel.name || 'default'}`);

        if (!s3Channel) {
            return { success: false, error: 'No S3 channel provided' };
        }

        const { endpoint, pathStyle, accessKeyId, secretAccessKey, bucketName, region } = s3Channel;

        const s3Client = new S3Client({
            region: region || "auto",
            endpoint,
            credentials: { accessKeyId, secretAccessKey },
            forcePathStyle: pathStyle
        });

        const multipartKey = `multipart_${uploadId}`;


        let finalFileId;

        // 如果是第一个分块，生成并保存 finalFileId
        if (chunkIndex === 0 && !await db.get(multipartKey)) {
            finalFileId = await buildUniqueFileId(context, originalFileName, originalFileType);

            const createResponse = await s3Client.send(new CreateMultipartUploadCommand({
                Bucket: bucketName,
                Key: finalFileId,
                ContentType: originalFileType || 'application/octet-stream'
            }), { abortSignal: context.uploadSignal });

            const multipartInfo = {
                uploadId: createResponse.UploadId,
                key: finalFileId
            };

            multipartInfo.provider = 's3';
            multipartInfo.channelName = s3Channel.name;
            multipartInfo.providerIdentity = { endpoint, bucketName, region: region || 'auto', pathStyle: !!pathStyle };
            try {
                await registerMultipartRecovery(env, uploadId, multipartInfo);
                context.uploadSignal?.throwIfAborted();
                await db.put(multipartKey, JSON.stringify(multipartInfo), { expirationTtl: 3600 });
            } catch (error) {
                await s3Client.send(new AbortMultipartUploadCommand({ Bucket: bucketName, Key: multipartInfo.key, UploadId: multipartInfo.uploadId }),
                    { abortSignal: AbortSignal.timeout(15000) });
                throw error;
            }
        } else {
            // 其他分块需要等待第一个分块完成multipart upload初始化
            let multipartInfoData = null;
            let retryCount = 0;
            const maxRetries = 30; // 最多等待60秒

            while (!multipartInfoData && retryCount < maxRetries) {
                multipartInfoData = await db.get(multipartKey);
                if (!multipartInfoData) {
                    // 等待2秒后重试
                    await uploadDelay(2000, context.uploadSignal);
                    retryCount++;
                    console.log(`S3 chunk ${chunkIndex} waiting for multipart initialization... (${retryCount}/${maxRetries})`);
                }
            }

            if (!multipartInfoData) {
                return { success: false, error: 'Multipart upload not initialized after waiting' };
            }

            const multipartInfo = JSON.parse(multipartInfoData);
            finalFileId = multipartInfo.key;
        }

        // 获取multipart info
        const multipartInfoData = await db.get(multipartKey);
        if (!multipartInfoData) {
            return { success: false, error: 'Multipart upload not initialized' };
        }

        const multipartInfo = JSON.parse(multipartInfoData);

        // 上传分块
        const uploadResponse = await s3Client.send(new UploadPartCommand({
            Bucket: bucketName,
            Key: finalFileId,
            PartNumber: chunkIndex + 1,
            UploadId: multipartInfo.uploadId,
            Body: new Uint8Array(chunkData)
        }), { abortSignal: context.uploadSignal });

        if (!uploadResponse || !uploadResponse.ETag) {
            throw new Error(`Failed to upload part ${chunkIndex + 1} to S3`);
        }

        return {
            success: true,
            partNumber: chunkIndex + 1,
            etag: uploadResponse.ETag,
            size: chunkData.byteLength,
            uploadTime: Date.now(),
            s3Channel: s3Channel.name,
            multipartUploadId: multipartInfo.uploadId,
            key: finalFileId
        };

    } catch (error) {
        console.error(`S3 chunk upload error (chunk ${chunkIndex}):`, error.message, error.name, error.$metadata);
        return {
            success: false,
            error: error.message
        };
    }
}

// 上传单个分块到Telegram
async function uploadSingleChunkToTelegram(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType) {
    const { uploadConfig, specifiedChannelName } = context;

    try {
        const tgSettings = uploadConfig.telegram;
        const tgChannels = tgSettings.channels;
        
        // 优先使用指定的渠道名称
        let tgChannel;
        if (specifiedChannelName) {
            tgChannel = tgChannels.find(ch => ch.name === specifiedChannelName);
        }
        if (!tgChannel) {
            tgChannel = selectConsistentChannel(tgChannels, uploadId, tgSettings.loadBalance.enabled);
        }

        console.log(`Uploading Telegram chunk ${chunkIndex} for uploadId: ${uploadId}, selected channel: ${tgChannel.name || 'default'}`);

        if (!tgChannel) {
            return { success: false, error: 'No Telegram channel provided' };
        }

        const tgBotToken = tgChannel.botToken;
        const tgChatId = tgChannel.chatId;
        const tgProxyUrl = tgChannel.proxyUrl || '';

        // 创建分块文件名
        const chunkFileName = `${originalFileName}.part${chunkIndex.toString().padStart(3, '0')}`;
        context.uploadSignal?.throwIfAborted();
        const chunkBlob = new Blob([chunkData], { type: 'application/octet-stream' });

        // 上传分块到Telegram（支持代理域名）
        const chunkInfo = await uploadChunkToTelegramWithRetry(
            tgBotToken,
            tgChatId,
            tgProxyUrl,
            chunkBlob,
            chunkFileName,
            chunkIndex,
            totalChunks, // 传入正确的totalChunks
            2, // maxRetries
            context.uploadSignal
        );

        if (!chunkInfo) {
            return { success: false, error: 'Failed to upload chunk to Telegram' };
        }

        return {
            success: true,
            fileId: chunkInfo.file_id,
            size: chunkInfo.file_size,
            fileName: chunkFileName,
            uploadTime: Date.now(),
            tgChannel: tgChannel.name
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// 上传单个分块到Discord
async function uploadSingleChunkToDiscord(context, chunkData, chunkIndex, totalChunks, uploadId, originalFileName, originalFileType) {
    const { uploadConfig, specifiedChannelName } = context;

    try {
        const discordSettings = uploadConfig.discord;
        const discordChannels = discordSettings.channels;
        
        // 优先使用指定的渠道名称
        let discordChannel;
        if (specifiedChannelName) {
            discordChannel = discordChannels.find(ch => ch.name === specifiedChannelName);
        }
        if (!discordChannel) {
            discordChannel = selectConsistentChannel(discordChannels, uploadId, discordSettings.loadBalance?.enabled);
        }

        console.log(`Uploading Discord chunk ${chunkIndex} for uploadId: ${uploadId}, selected channel: ${discordChannel.name || 'default'}`);

        if (!discordChannel) {
            return { success: false, error: 'No Discord channel provided' };
        }

        const botToken = discordChannel.botToken;
        const channelId = discordChannel.channelId;

        // 创建分块文件名
        const chunkFileName = `${originalFileName}.part${chunkIndex.toString().padStart(3, '0')}`;
        context.uploadSignal?.throwIfAborted();
        const chunkBlob = new Blob([chunkData], { type: 'application/octet-stream' });

        // 上传分块到Discord（带重试）
        const chunkInfo = await uploadChunkToDiscordWithRetry(
            botToken,
            channelId,
            chunkBlob,
            chunkFileName,
            chunkIndex,
            totalChunks,
            2, // maxRetries
            context.uploadSignal
        );

        if (!chunkInfo) {
            return { success: false, error: 'Failed to upload chunk to Discord' };
        }

        return {
            success: true,
            messageId: chunkInfo.message_id,
            // 注意：不存储 attachmentId 和 url，因为它们会在约24小时后过期
            // 读取时会通过 messageId 获取新的 URL
            size: chunkInfo.file_size,
            fileName: chunkFileName,
            uploadTime: Date.now(),
            discordChannel: discordChannel.name
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

// 将每个分块上传至Discord，支持失败重试和 rate limit 处理
async function uploadChunkToDiscordWithRetry(botToken, channelId, chunkBlob, chunkFileName, chunkIndex, totalChunks, maxRetries = 2, signal) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            signal?.throwIfAborted();
            const discordAPI = new DiscordAPI(botToken);

            const response = await discordAPI.sendFile(chunkBlob, channelId, chunkFileName, { signal });

            if (!response || !response.id) {
                throw new Error('Invalid Discord response');
            }

            const fileInfo = discordAPI.getFileInfo(response);
            if (!fileInfo) {
                throw new Error('Failed to extract file info from response');
            }

            return fileInfo;

        } catch (error) {
            console.warn(`Discord chunk ${chunkIndex} upload attempt ${attempt + 1} failed:`, error.message);

            // 检查是否是 rate limit (429)
            if (error.message && error.message.includes('429')) {
                // 从错误消息中提取 retry_after，或使用默认值
                const retryAfter = 5000; // 默认等待 5 秒
                console.log(`Discord rate limited, waiting ${retryAfter}ms...`);
                await uploadDelay(retryAfter, signal);
                continue; // 不计入重试次数
            }

            if (attempt === maxRetries - 1) {
                return null; // 最后一次尝试也失败了
            }

            // 指数退避延迟
            await uploadDelay(1000 * (attempt + 1), signal);
        }
    }

    return null;
}

/* ======== 分块合并时与上传相关的工具函数 ======= */

// 重传失败的分块
// 并发重试失败的分块
export async function retryFailedChunks(context, failedChunks, uploadChannel) {
    // D1 deliberately retains no binary retry copy. A non-2xx part response tells
    // the client to resend; merge never discards that still-retryable session.
    await uploadMap(failedChunks.filter(chunk => chunk.hasData), async chunk => {
        const record = await getDatabase(context.env).getWithMetadata(chunk.key, { type: 'arrayBuffer' });
        const m = record.metadata;
        try { await uploadChunkToStorageWithTimeout(context, chunk.index, m.totalChunks, m.uploadId,
            m.originalFileName, m.originalFileType, uploadChannel, record.value); } catch { /* returned status describes failure */ }
    }, 3);
}

export async function cleanupFailedMultipartUploads(context, uploadId, uploadChannel) {
    const { env, uploadConfig } = context;
    const db = getDatabase(env);

    try {
        const multipartKey = `multipart_${uploadId}`;
        const multipartInfoData = await db.get(multipartKey);

        if (!multipartInfoData) {
            return; // 没有multipart upload需要清理
        }

        const multipartInfo = JSON.parse(multipartInfoData);

        if (uploadChannel === 'cfr2') {
            // 清理R2 multipart upload
            const R2DataBase = env.img_r2;
            const multipartUpload = R2DataBase.resumeMultipartUpload(multipartInfo.key, multipartInfo.uploadId);
            await multipartUpload.abort();

        } else if (uploadChannel === 's3') {
            // 清理S3 multipart upload
            const s3Settings = uploadConfig.s3;
            const s3Channels = s3Settings.channels;
            
            // 优先使用指定的渠道名称
            let s3Channel;
            const specifiedChannelName = context.specifiedChannelName;
            if (specifiedChannelName) {
                s3Channel = s3Channels.find(ch => ch.name === specifiedChannelName);
            }
            if (!s3Channel) {
                s3Channel = selectConsistentChannel(s3Channels, uploadId, s3Settings.loadBalance.enabled);
            }

            if (s3Channel) {
                const { endpoint, pathStyle, accessKeyId, secretAccessKey, bucketName, region } = s3Channel;

                const s3Client = new S3Client({
                    region: region || "auto",
                    endpoint,
                    credentials: { accessKeyId, secretAccessKey },
                    forcePathStyle: pathStyle
                });

                await s3Client.send(new AbortMultipartUploadCommand({
                    Bucket: bucketName,
                    Key: multipartInfo.key,
                    UploadId: multipartInfo.uploadId
                }));
            }
        }

        // 清理multipart info
        await db.delete(multipartKey);
        await finishMultipartRecovery(env, uploadId);
        console.log(`Cleaned up failed multipart upload for ${uploadId}`);

    } catch (error) {
        console.error(`Failed to cleanup multipart upload for ${uploadId}:`, error);
    }
}


// 检查分块上传状态
export async function checkChunkUploadStatuses(env, uploadId, totalChunks, indices) {
    const db = getDatabase(env);
    return uploadMap(indices || Array.from({ length: totalChunks }, (_, i) => i), async i => {
        const key = `chunk_${uploadId}_${String(i).padStart(3, '0')}`;
        try {
            const record = await db.getWithMetadata(key, { type: 'arrayBuffer' });
            const m = record?.metadata;
            if (!m) return { index: i, key, status: 'missing', hasData: false };
            // A read must not race the writer by changing its state.
            const status = m.status === 'uploading' && Date.now() > m.timeoutThreshold ? 'timeout' : m.status;
            return { ...m, index: i, key, status, hasData: !!record.value?.byteLength };
        } catch (error) { return { index: i, key, status: 'error', error: error.message, hasData: false }; }
    }, 2);
}

export async function cleanupChunkData(env, uploadId, totalChunks) {
    const db = getDatabase(env);
    await uploadMap(Array.from({ length: totalChunks }, (_, i) => i), i =>
        db.delete(`chunk_${uploadId}_${String(i).padStart(3, '0')}`));
    await db.delete(`multipart_${uploadId}`);
}

// 清理上传会话
export async function cleanupUploadSession(env, uploadId) {
    try {
        const db = getDatabase(env);

        const sessionKey = `upload_session_${uploadId}`;
        await db.delete(sessionKey);
        console.log(`Cleaned up upload session for ${uploadId}`);
    } catch (cleanupError) {
        console.warn('Failed to cleanup upload session:', cleanupError);
    }
}

// 强制清理所有相关数据（用于彻底清理失败的上传）
export async function forceCleanupUpload(context, uploadId, totalChunks) {
    const { env } = context;
    const db = getDatabase(env);

    try {
        // 读取 session 信息
        const sessionKey = `upload_session_${uploadId}`;
        const sessionRecord = await db.get(sessionKey);
        const uploadChannel = sessionRecord ? JSON.parse(sessionRecord).uploadChannel : 'cfr2'; // 默认使用 cfr2

        // 清理 multipart upload信息
        await cleanupFailedMultipartUploads(context, uploadId, uploadChannel);

        const cleanupPromises = [];

        // 清理所有分块
        for (let i = 0; i < totalChunks; i++) {
            const chunkKey = `chunk_${uploadId}_${i.toString().padStart(3, '0')}`;
            cleanupPromises.push(db.delete(chunkKey).catch(err =>
                console.warn(`Failed to delete chunk ${i}:`, err)
            ));
        }

        // 清理相关的键
        const keysToCleanup = [
            `upload_session_${uploadId}`,
            `multipart_${uploadId}`
        ];

        keysToCleanup.forEach(key => {
            cleanupPromises.push(db.delete(key).catch(err =>
                console.warn(`Failed to delete key ${key}:`, err)
            ));
        });

        await Promise.allSettled(cleanupPromises);
        console.log(`Force cleanup completed for ${uploadId}`);

    } catch (cleanupError) {
        console.warn('Failed to force cleanup upload:', cleanupError);
    }
}

/* ======= 单个大文件大文件分块上传到Telegram ======= */
export async function uploadLargeFileToTelegram(context, file, fullId, metadata, fileName, fileType, returnLink, tgBotToken, tgChatId, tgChannel) {
    const { env, waitUntil } = context;
    const db = getDatabase(env);

    const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB (TG Bot getFile download limit: 20MB, leave 4MB safety margin)
    const fileSize = file.size;
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);

    // 为了避免CPU超时，限制最大分片数（考虑Cloudflare Worker的CPU时间限制）
    if (totalChunks > 50) {
        return createResponse('Error: File too large (exceeds 1GB limit)', { status: 413 });
    }

    const chunks = [];
    const uploadedChunks = [];

    try {
        // 分片上传，每10个分片做一次微小延迟以避免CPU超时
        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, fileSize);
            const chunkBlob = file.slice(start, end);

            // 生成分片文件名
            const chunkFileName = `${fileName}.part${i.toString().padStart(3, '0')}`;

            // 上传分片（带重试机制）
            const tgProxyUrl = tgChannel.proxyUrl || '';
            const chunkInfo = await uploadChunkToTelegramWithRetry(
                tgBotToken,
                tgChatId,
                tgProxyUrl,
                chunkBlob,
                chunkFileName,
                i,
                totalChunks
            );

            if (!chunkInfo) {
                throw new Error(`Failed to upload chunk ${i + 1}/${totalChunks} after retries`);
            }

            // 验证分片信息完整性
            if (!chunkInfo.file_id || !chunkInfo.file_size) {
                throw new Error(`Invalid chunk info for chunk ${i + 1}/${totalChunks}`);
            }

            chunks.push({
                index: i,
                fileId: chunkInfo.file_id,
                size: chunkInfo.file_size,
                fileName: chunkFileName
            });

            uploadedChunks.push(chunkInfo.file_id);

            // 每10个分片检查一下，添加微小延迟避免CPU限制
            if (i > 0 && i % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 50)); // 50ms延迟
            }
        }

        // 所有分片上传成功，更新metadata
        metadata.Channel = "TelegramNew";
        metadata.ChannelName = tgChannel.name;
        metadata.IsChunked = true;
        metadata.TotalChunks = totalChunks;
        metadata.FileSize = (fileSize / 1024 / 1024).toFixed(2);


        // 将分片信息存储到value中
        const chunksData = JSON.stringify(chunks);

        // 验证分片完整性
        if (chunks.length !== totalChunks) {
            throw new Error(`Chunk count mismatch: expected ${totalChunks}, got ${chunks.length}`);
        }

        // 写入最终的数据库记录，分片信息作为value
        await db.put(fullId, chunksData, { metadata });

        // 异步结束上传
        waitUntil(endUpload(context, fullId, metadata));

        // 构建公开访问链接（使用 urlPrefix 配置）
        const pageConfig = await fetchPageConfig(env, context);
        const urlPrefixConfig = pageConfig.config?.find(c => c.id === 'urlPrefix');
        const urlPrefix = urlPrefixConfig?.value || '';
        const responseBody = [{ 'src': returnLink }];
        if (urlPrefix) {
            responseBody[0].publicUrl = `${urlPrefix.replace(/\/+$/, '')}/${fullId}`;
        }

        return createResponse(
            JSON.stringify(responseBody),
            {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                }
            }
        );

    } catch (error) {
        return createResponse(`Telegram Channel Error: Large file upload failed - ${error.message}`, { status: 500 });
    }
}

// 将每个分块上传至Telegram，支持失败重试（支持代理域名）
async function uploadChunkToTelegramWithRetry(tgBotToken, tgChatId, tgProxyUrl, chunkBlob, chunkFileName, chunkIndex, totalChunks, maxRetries = 2, signal) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            signal?.throwIfAborted();
            const tgAPI = new TelegramAPI(tgBotToken, tgProxyUrl);

            const caption = `Part ${chunkIndex + 1}/${totalChunks}`;

            const response = await tgAPI.sendFile(chunkBlob, tgChatId, 'sendDocument', 'document', caption, chunkFileName, { signal });
            if (!response.ok) {
                throw new Error(response.description || 'Telegram API error');
            }

            const fileInfo = tgAPI.getFileInfo(response);
            if (!fileInfo) {
                throw new Error('Failed to extract file info from response');
            }

            return fileInfo;

        } catch (error) {
            console.warn(`Chunk ${chunkIndex} upload attempt ${attempt + 1} failed:`, error.message);

            if (attempt === maxRetries - 1) {
                return null; // 最后一次尝试也失败了
            }

            // 减少重试等待时间以节省CPU时间
            await uploadDelay(500 * (attempt + 1), signal);
        }
    }

    return null;
}
