import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { inject } from './httpHarness.ts';

test('accounting access defaults on for admins, can be revoked, and excludes employees',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pv-accounting-'));
  const oldUploadDir=process.env.UPLOAD_DIR; process.env.UPLOAD_DIR=root;
  const db=openDatabase(':memory:'); runMigrations(db); const app=createApp(db);
  let cookie='',csrf='';
  async function call(method:string,url:string,body?:unknown) {
    const res=await inject(app,method,url,body===undefined?undefined:JSON.stringify(body),{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf});
    return {res,status:res.status,data:(res.headers.get('content-type')||'').includes('json')?await res.json():null};
  }
  try {
    const setup=await call('POST','/api/auth/setup',{login:'admin',password:'long-password-123',fullName:'Admin'});
    cookie=setup.res.headers.get('set-cookie')!.split(';')[0];csrf=setup.data.csrfToken;
    const adminCookie=cookie,adminCsrf=csrf;
    const worker=await call('POST','/api/users',{login:'worker',fullName:'Worker',password:'long-password-123'});
    const workerId=worker.data.user.id;
    const promoted=await call('PATCH',`/api/users/${workerId}`,{role:'admin'});
    assert.equal(promoted.data.user.role,'admin'); assert.equal(promoted.data.user.documentsAccess,true);
    const boundary='test-accounting-boundary';
    const multipart=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="invoice.txt"\r\nContent-Type: text/plain\r\n\r\nprivate document\r\n--${boundary}--\r\n`);
    const upload=await inject(app,'POST','/api/documents',multipart,{'Content-Type':`multipart/form-data; boundary=${boundary}`,Cookie:cookie,'X-CSRF-Token':csrf});
    assert.equal(upload.status,201); const document=(await upload.json()).document;
    assert.equal(document.original_name,'invoice.txt');
    assert.equal((await call('GET','/api/documents?q=VOICE')).data.documents.length,1);
    assert.equal((await call('GET','/api/documents?category=drawings')).data.documents.length,0);
    const download = await inject(app,'GET',`/api/documents/${document.id}/download`,undefined,{Cookie:cookie});
    assert.equal(download.status,200);
    assert.equal(await download.text(),'private document');
    assert.equal((await call('PATCH',`/api/documents/${document.id}`,{category:'drawings'})).status,200);
    assert.equal((await call('GET','/api/documents?category=acts')).data.documents.length,0);
    assert.equal((await call('GET','/api/documents?category=drawings')).data.documents.length,1);
    assert.equal((await call('PATCH',`/api/documents/${document.id}`,{category:'invalid'})).status,400);
    const login=await call('POST','/api/auth/login',{login:'worker',password:'long-password-123'});
    cookie=login.res.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrfToken;
    assert.equal((await call('GET','/api/documents')).status,200);
    cookie=adminCookie;csrf=adminCsrf;
    assert.equal((await call('PATCH',`/api/users/${workerId}`,{documentsAccess:false})).data.user.documentsAccess,false);
    cookie=login.res.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrfToken;
    assert.equal((await call('GET','/api/documents')).status,403);
    assert.equal((await call('GET',`/api/documents/${document.id}/download`)).status,403);
    assert.equal((await call('PATCH',`/api/users/${workerId}`,{documentsAccess:true})).status,200);
    assert.equal((await call('GET','/api/documents')).status,200);
    cookie=adminCookie;csrf=adminCsrf;
    await call('PATCH',`/api/users/${workerId}`,{role:'employee'});
    cookie=login.res.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrfToken;
    assert.equal((await call('GET','/api/documents')).status,403);
  } finally {
    db.close(); if(oldUploadDir===undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR=oldUploadDir;
    if(path.dirname(root)===path.resolve(os.tmpdir()) && path.basename(root).startsWith('pv-accounting-')) fs.rmSync(root,{recursive:true,force:true});
  }
});
