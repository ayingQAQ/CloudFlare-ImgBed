import { directoryPath, saveDirectory } from '../../utils/directories.js';

export async function onRequest({ request, env }) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    let path;
    try { path = directoryPath((await request.json()).path); }
    catch { return Response.json({ error: '文件夹名称或路径无效' }, { status: 400 }); }
    await saveDirectory(env, path);
    return Response.json({ success: true, path });
}
