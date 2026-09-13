// Production Routes entry point; metadata and storage are shared with origin.
import application from './index.js';
import { syncOriginChannels } from '../../functions/utils/originChannels.js';
import { withOriginFallback } from './origin-fallback.js';

export default {
    async scheduled(event, env, ctx) {
        await syncOriginChannels(env);
        return application.scheduled?.(event, env, ctx);
    },
    fetch(request, env, ctx) {
        const url = new URL(request.url);
        let forwardedScheme = '';
        try { forwardedScheme = JSON.parse(request.headers.get('cf-visitor') || '{}').scheme || ''; } catch {}
        if (url.protocol === 'http:' || forwardedScheme === 'http') {
            url.protocol = 'https:';
            return Response.redirect(url, 301);
        }
        return withOriginFallback(request, env, ctx,
            (input, bindings, execution) => application.fetch(input, bindings, execution));
    },
};
