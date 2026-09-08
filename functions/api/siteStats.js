import { getDatabase } from '../utils/databaseAdapter.js';
import { readIndex } from '../utils/indexManager.js';

const VISIT_COUNT_KEY = 'manage@siteStats@visits';
const VISIT_COOKIE = 'imgbed_visit';

function hasVisitCookie(request) {
    const cookies = request.headers.get('Cookie') || '';
    return cookies.split(';').some(part => part.trim().startsWith(`${VISIT_COOKIE}=`));
}

async function getImageCount(context) {
    const result = await readIndex(context, { fileType: 'image', countOnly: true });
    return Number(result.totalCount) || 0;
}

async function getVisitCount(env) {
    const value = await getDatabase(env).get(VISIT_COUNT_KEY);
    return Number.parseInt(value || '0', 10) || 0;
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

export async function onRequestGet(context) {
    const [visits, images] = await Promise.all([
        getVisitCount(context.env),
        getImageCount(context)
    ]);
    return json({ visits, images });
}

export async function onRequestPost(context) {
    const alreadyCounted = hasVisitCookie(context.request);
    const db = getDatabase(context.env);
    let visits = await getVisitCount(context.env);

    if (!alreadyCounted) {
        visits += 1;
        await db.put(VISIT_COUNT_KEY, String(visits));
    }

    const images = await getImageCount(context);
    const headers = alreadyCounted ? {} : {
        'Set-Cookie': `${VISIT_COOKIE}=1; Path=/; Max-Age=86400; SameSite=Lax; Secure`
    };
    return json({ visits, images }, headers);
}
