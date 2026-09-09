import { readIndex } from '../utils/indexManager.js';
import { getSiteStats, recordVisit } from '../utils/siteStats.js';
import { getDatabase } from '../utils/databaseAdapter.js';

const VISIT_COOKIE = 'imgbed_visit';

function hasVisitCookie(request) {
    const cookies = request.headers.get('Cookie') || '';
    return cookies.split(';').some(part => part.trim().startsWith(`${VISIT_COOKIE}=`));
}

async function getInitialImageCount(context) {
    const result = await readIndex(context, { fileType: 'image', countOnly: true });
    return Number(result.totalCount) || 0;
}

function json(data, headers = {}) {
    return new Response(JSON.stringify(data), {
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...headers
        }
    });
}

async function loadStats(context) {
    const current = await getSiteStats(context.env.img_r2);
    if (current.initialized) return current;
    const [images, legacyVisits] = await Promise.all([
        getInitialImageCount(context),
        getDatabase(context.env).get('manage@siteStats@visits'),
    ]);
    return getSiteStats(context.env.img_r2, images, legacyVisits);
}

export async function onRequestGet(context) {
    const stats = await loadStats(context);
    return json({ visits: stats.visits, images: stats.images });
}

export async function onRequestPost(context) {
    const alreadyCounted = hasVisitCookie(context.request);
    const current = await loadStats(context);
    const stats = alreadyCounted ? current : await recordVisit(context.env.img_r2);
    const headers = alreadyCounted ? {} : {
        'Set-Cookie': `${VISIT_COOKIE}=1; Path=/; Max-Age=86400; SameSite=Lax; Secure`
    };
    return json({ visits: stats.visits, images: stats.images }, headers);
}
