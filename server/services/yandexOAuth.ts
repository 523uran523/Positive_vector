import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { sessionSecret } from '../config.ts';
import { createYandexBackupStore, type CloudBackupStore } from './yandexBackup.ts';

type Config={clientId:string;clientSecret:string;redirectUri:string};
type Tokens={accessToken:string;refreshToken:string;expiresAt:number;refreshedAt:number};
type Pending={sessionId:string;userId:string;verifier:string;expiresAt:number};

export function yandexConfig(env:NodeJS.ProcessEnv=process.env):Config|null {
  const clientId=env.YANDEX_OAUTH_CLIENT_ID?.trim(),clientSecret=env.YANDEX_OAUTH_CLIENT_SECRET?.trim(),redirectUri=env.YANDEX_OAUTH_REDIRECT_URI?.trim();
  if(!clientId || !clientSecret || !redirectUri) return null;
  try {
    const uri=new URL(redirectUri);
    if((uri.protocol!=='https:' && !(uri.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(uri.hostname))) || uri.pathname!=='/api/integrations/yandex/callback' || uri.search || uri.hash || uri.username || uri.password) return null;
  } catch {return null;}
  return {clientId,clientSecret,redirectUri};
}

export function createYandexOAuth(db:DatabaseSync,options:{request?:typeof fetch;config?:()=>Config|null}={}) {
  const request=options.request||fetch,getConfig=options.config||(()=>yandexConfig());
  const pending=new Map<string,Pending>();
  let generation=0;
  const key=()=>crypto.createHmac('sha256',sessionSecret()).update('positive-vector-yandex-oauth-v1').digest();
  const encrypt=(value:Tokens)=>{
    const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(),iv);
    const encrypted=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
    return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});
  };
  const decrypt=(value:string):Tokens=>{
    const record=JSON.parse(value) as {v:number;iv:string;tag:string;data:string};
    if(record.v!==1) throw new Error('Неподдерживаемый формат подключения.');
    const decipher=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(record.iv,'base64'));
    decipher.setAuthTag(Buffer.from(record.tag,'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.data,'base64')),decipher.final()]).toString('utf8')) as Tokens;
  };
  const getTokens=():Tokens|null=>{
    const row=db.prepare('SELECT encrypted_tokens FROM yandex_connection WHERE singleton=1').get() as {encrypted_tokens:string}|undefined;
    return row ? decrypt(row.encrypted_tokens) : null;
  };
  const save=(tokens:Tokens,userId?:string)=>db.prepare(`INSERT INTO yandex_connection(singleton,encrypted_tokens,connected_at,connected_by) VALUES (1,?,?,?)
    ON CONFLICT(singleton) DO UPDATE SET encrypted_tokens=excluded.encrypted_tokens,connected_at=CASE WHEN excluded.connected_by IS NULL THEN yandex_connection.connected_at ELSE excluded.connected_at END,connected_by=COALESCE(excluded.connected_by,yandex_connection.connected_by)`)
    .run(encrypt(tokens),new Date().toISOString(),userId||null);
  async function exchange(fields:Record<string,string>,config:Config):Promise<Tokens> {
    const body=new URLSearchParams({...fields,client_id:config.clientId,client_secret:config.clientSecret});
    const response=await request('https://oauth.yandex.ru/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
    if(!response.ok) throw new Error('Яндекс не подтвердил подключение. Проверьте настройки приложения или повторите вход.');
    const data=await response.json() as {access_token?:unknown;refresh_token?:unknown;expires_in?:unknown};
    if(typeof data.access_token!=='string' || typeof data.refresh_token!=='string' || typeof data.expires_in!=='number' || !Number.isFinite(data.expires_in) || data.expires_in<=0) throw new Error('Яндекс вернул неполный ответ авторизации.');
    return {accessToken:data.access_token,refreshToken:data.refresh_token,expiresAt:Date.now()+data.expires_in*1000,refreshedAt:Date.now()};
  }
  return {
    status(){return {configured:Boolean(getConfig()),connected:Boolean(db.prepare('SELECT 1 FROM yandex_connection WHERE singleton=1').get())};},
    start(sessionId:string,userId:string){
      const config=getConfig();if(!config) throw new Error('Сначала настройте OAuth-приложение Яндекса на сервере.');
      for(const [state,item] of pending) if(item.expiresAt<Date.now()) pending.delete(state);
      const state=crypto.randomBytes(32).toString('base64url'),verifier=crypto.randomBytes(48).toString('base64url');
      pending.set(state,{sessionId,userId,verifier,expiresAt:Date.now()+10*60_000});
      const params=new URLSearchParams({response_type:'code',client_id:config.clientId,redirect_uri:config.redirectUri,scope:'cloud_api:disk.app_folder',state,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
      return `https://oauth.yandex.ru/authorize?${params}`;
    },
    async callback(state:string,code:string,sessionId:string,userId:string){
      const item=pending.get(state);pending.delete(state);
      if(!item || item.expiresAt<Date.now() || item.sessionId!==sessionId || item.userId!==userId || !code || code.length>2048) throw new Error('Запрос подключения устарел. Начните заново.');
      const config=getConfig();if(!config) throw new Error('Настройки OAuth отсутствуют.');
      const observed=generation;
      const tokens=await exchange({grant_type:'authorization_code',code,code_verifier:item.verifier,redirect_uri:config.redirectUri},config);
      if(observed!==generation) throw new Error('Подключение было отменено.');
      save(tokens,userId);
    },
    disconnect(){generation++;db.prepare('DELETE FROM yandex_connection WHERE singleton=1').run();pending.clear();},
    async cloud():Promise<CloudBackupStore|null>{
      let tokens=getTokens();if(!tokens) return null;
      const config=getConfig();if(!config) throw new Error('Подключение Яндекса требует настройки OAuth на сервере.');
      if(tokens.expiresAt<Date.now()+5*60_000 || Date.now()-tokens.refreshedAt>80*24*3600_000) {
        const observed=generation;
        tokens=await exchange({grant_type:'refresh_token',refresh_token:tokens.refreshToken},config);
        if(observed!==generation) return null;
        save(tokens);
      }
      return createYandexBackupStore(tokens.accessToken,request);
    },
  };
}
