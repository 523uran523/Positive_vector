import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { openDatabase,runMigrations } from '../server/db.ts';
import { createYandexOAuth,yandexConfig } from '../server/services/yandexOAuth.ts';
import { inject } from './httpHarness.ts';

test('Yandex connection uses session-bound state, PKCE and encrypted server storage',async()=>{
  const db=openDatabase(':memory:');runMigrations(db);
  let exchanges=0;
  const fakeFetch=(async(url:string|URL|Request,init?:RequestInit)=>{
    assert.equal(String(url),'https://oauth.yandex.ru/token');exchanges++;
    const params=new URLSearchParams(String(init?.body));
    assert.equal(params.get('grant_type'),'authorization_code');assert.ok(params.get('code_verifier'));
    return Response.json({access_token:'synthetic-access-token',refresh_token:'synthetic-refresh-token',expires_in:3600});
  }) as typeof fetch;
  const config=()=>({clientId:'test-client',clientSecret:'test-secret',redirectUri:'https://example.test/api/integrations/yandex/callback'});
  const oauth=createYandexOAuth(db,{request:fakeFetch,config});const app=createApp(db,oauth);
  let cookie='',csrf='';
  async function call(method:string,url:string,body?:unknown){
    const res=await inject(app,method,url,body===undefined?undefined:JSON.stringify(body),{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf});
    const data=(res.headers.get('content-type')||'').includes('json')?await res.json():null;return {res,data,status:res.status};
  }
  try {
    assert.equal((await call('GET','/api/integrations/yandex/status')).status,401);
    const login=await call('POST','/api/auth/setup',{login:'admin',password:'long-password-123',fullName:'Admin'});
    cookie=login.res.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrfToken;
    assert.deepEqual((await call('GET','/api/integrations/yandex/status')).data.configured,true);
    const start=await call('POST','/api/integrations/yandex/start',{}),url=new URL(start.data.url);
    assert.equal(url.origin,'https://oauth.yandex.ru');assert.equal(url.searchParams.get('scope'),'cloud_api:disk.app_folder');
    assert.equal(url.searchParams.get('code_challenge_method'),'S256');
    const state=url.searchParams.get('state')!;
    await assert.rejects(oauth.callback(state,'code','wrong-session',login.data.user.id));assert.equal(exchanges,0);
    const second=await call('POST','/api/integrations/yandex/start',{}),url2=new URL(second.data.url);
    const callback=await call('GET',`/api/integrations/yandex/callback?state=${encodeURIComponent(url2.searchParams.get('state')!)}&code=synthetic-code`);
    assert.equal(callback.status,303);assert.equal(callback.res.headers.get('location'),'/?yandex_connection=connected');assert.equal(exchanges,1);
    assert.equal((await call('GET','/api/integrations/yandex/status')).data.connected,true);
    const stored=String((db.prepare('SELECT encrypted_tokens FROM yandex_connection').get() as any).encrypted_tokens);
    assert.ok(!stored.includes('synthetic-access-token')&&!stored.includes('synthetic-refresh-token'));
    assert.ok(await oauth.cloud());
    const state3=new URL((await call('POST','/api/integrations/yandex/start',{})).data.url).searchParams.get('state')!;
    const challenge=crypto.createHash('sha256').update('not-the-verifier').digest('base64url');assert.notEqual(url2.searchParams.get('code_challenge'),challenge);
    assert.equal((await call('POST','/api/integrations/yandex/disconnect',{})).status,200);
    await assert.rejects(oauth.callback(state3,'code','irrelevant',login.data.user.id));
    assert.equal(await oauth.cloud(),null);
  } finally {db.close();}
});

test('OAuth configuration refuses nonlocal insecure callbacks',()=>{
  assert.equal(yandexConfig({YANDEX_OAUTH_CLIENT_ID:'id',YANDEX_OAUTH_CLIENT_SECRET:'secret',YANDEX_OAUTH_REDIRECT_URI:'http://example.com/api/integrations/yandex/callback'}),null);
  assert.ok(yandexConfig({YANDEX_OAUTH_CLIENT_ID:'id',YANDEX_OAUTH_CLIENT_SECRET:'secret',YANDEX_OAUTH_REDIRECT_URI:'http://127.0.0.1:4178/api/integrations/yandex/callback'}));
});
