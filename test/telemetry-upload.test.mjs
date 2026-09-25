import test from 'node:test';
import assert from 'node:assert/strict';
import { telemetryData } from '../functions/utils/middleware.js';
for (const mode of ['no-cf','start-fails','finish-fails','handler-fails']) {
 test(`telemetry ${mode} invokes upload once and preserves its result`, async()=>{
  let calls=0;
  const expected=new Error('upload failure');
  const context={env:{img_url:{get:async()=>JSON.stringify({telemetry:{enabled:true}})}},request:new Request('https://imgb.top/upload'),data:{sentry:{setTag(){},setContext(){},startTransaction(){if(mode==='start-fails')throw Error('sentry');return {finish(){if(mode==='finish-fails')throw Error('finish')}};}}},next:async()=>{calls++;if(mode==='handler-fails')throw expected;return new Response('uploaded')}};
  if(mode==='handler-fails')await assert.rejects(telemetryData(context), e=>e===expected);
  else assert.equal(await (await telemetryData(context)).text(),'uploaded');
  assert.equal(calls,1);
 });
}
