import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations, withTransaction } from '../server/db.ts';
import { hashPassword } from '../server/security.ts';
import { inject } from './httpHarness.ts';

test('offline replays: atomic stock, conflicts, actor isolation and multipart deduplication',async()=>{
  const upload=fs.mkdtempSync(path.join(os.tmpdir(),'pv-sync-test-'));
  const oldUpload=process.env.UPLOAD_DIR;process.env.UPLOAD_DIR=upload;
  const db=openDatabase(':memory:');runMigrations(db);let app=createApp(db);
  const send=async(method:string,url:string,body:any,client?:any,key?:string,version?:string)=>{
    const headers:Record<string,string>={'Content-Type':'application/json'};
    if(client){headers.Cookie=client.cookie;headers['X-CSRF-Token']=client.csrf;}
    if(key){headers['Idempotency-Key']=key;headers['X-Operation-Created-At']=new Date().toISOString();}if(version)headers['If-Match']=version;
    const res=await inject(app,method,url,body===undefined?undefined:JSON.stringify(body),headers);
    return {status:res.status,data:await res.json(),res};
  };
  try {
    const setup=await send('POST','/api/auth/setup',{login:'admin',password:'long-password-123',fullName:'Admin'});
    assert.equal(setup.status,201);
    const admin={cookie:setup.res.headers.get('set-cookie')!.split(';')[0],csrf:setup.data.csrfToken};
    const create=await send('POST','/api/orders',{title:'Replay test'},admin,crypto.randomUUID());
    assert.equal(create.status,201);const id=create.data.order.id;
    const material=await send('POST','/api/warehouse/materials',{name:'Steel',unit:'kg',initialQtyMilli:10000,purchasePriceKopecks:100,minThresholdMilli:0},admin,crypto.randomUUID());
    assert.equal(material.status,201);const materialId=material.data.material.id;
    const consumeKey=crypto.randomUUID();
    const consumeBody={itemType:'material',opType:'consume',materialId,qtyMilli:2000};
    const first=await send('POST',`/api/orders/${id}/resources`,consumeBody,admin,consumeKey);
    assert.equal(first.status,201);
    app=createApp(db); // Lost response/recreated server: receipt comes from SQLite.
    const retry=await send('POST',`/api/orders/${id}/resources`,consumeBody,admin,consumeKey);
    assert.equal(retry.status,201);assert.deepEqual(retry.data,first.data);
    assert.equal(db.prepare('SELECT quantity_milli FROM materials WHERE id = ?').get(materialId)?.quantity_milli,8000);
    assert.equal((await send('POST',`/api/orders/${id}/resources`,{...consumeBody,qtyMilli:3000},admin,consumeKey)).status,409);
    const badKey=crypto.randomUUID();
    const invalid=await send('POST',`/api/orders/${id}/resources`,{...consumeBody,qtyMilli:-1},admin,badKey);
    assert.equal(invalid.status,400);
    assert.equal(db.prepare('SELECT 1 FROM mutation_receipts WHERE operation_id = ?').get(badKey),undefined);
    const snapshot=await send('GET',`/api/orders/${id}`,undefined,admin);
    const version=snapshot.data._versions[`/api/orders/${id}`];assert.ok(version);
    const updateKey=crypto.randomUUID();
    const updated=await send('PATCH',`/api/orders/${id}`,{title:'First editor'},admin,updateKey,version);
    assert.equal(updated.status,200);
    const stale=await send('PATCH',`/api/orders/${id}`,{title:'Second editor'},admin,crypto.randomUUID(),version);
    assert.equal(stale.status,409);assert.equal(stale.data.code,'VERSION_CONFLICT');
    assert.equal((await send('PATCH',`/api/orders/${id}`,{title:'First editor'},admin,updateKey,version)).status,200);
    const matVersion=material.data._versions[`/api/warehouse/materials/${materialId}`];
    assert.equal((await send('DELETE',`/api/warehouse/materials/${materialId}`,{},admin,crypto.randomUUID(),matVersion)).status,409);
    const current=await send('GET',`/api/orders/${id}`,undefined,admin);
    assert.equal((await send('DELETE',`/api/orders/${id}`,{},admin,crypto.randomUUID(),current.data._versions[`/api/orders/${id}`])).status,409);
    const simple=await send('POST','/api/orders',{title:'Delete without history'},admin,crypto.randomUUID());
    const simpleId=simple.data.order.id;
    assert.equal((await send('DELETE',`/api/orders/${simpleId}`,{},admin,crypto.randomUUID(),simple.data._versions[`/api/orders/${simpleId}`])).status,200);
    assert.equal((await send('PATCH',`/api/orders/${simpleId}`,{title:'Deleted offline'},admin,crypto.randomUUID(),simple.data._versions[`/api/orders/${simpleId}`])).status,404);
    const now=new Date().toISOString();
    db.prepare("INSERT INTO users(id,login,password_hash,role,full_name,created_at,updated_at) VALUES ('other','other',?,'employee','Other',?,?)").run(hashPassword('long-password-123'),now,now);
    const login=await send('POST','/api/auth/login',{login:'other',password:'long-password-123'});
    const other={cookie:login.res.headers.get('set-cookie')!.split(';')[0],csrf:login.data.csrfToken};
    assert.equal((await send('POST',`/api/orders/${id}/resources`,consumeBody,other,consumeKey)).status,403);
    const fileKey=crypto.randomUUID();
    async function uploadFile(visitId?:string) {
      const fd=new FormData();fd.append('file',new File(['sample'],'sample.txt',{type:'text/plain'}));if(visitId)fd.append('visitId',visitId);
      const request=new Request('http://in-process',{method:'POST',body:fd});
      const res=await inject(app,'POST',`/api/orders/${id}/attachments`,Buffer.from(await request.arrayBuffer()),{'Content-Type':request.headers.get('Content-Type')!,Cookie:admin.cookie,'X-CSRF-Token':admin.csrf,'Idempotency-Key':fileKey,'X-Operation-Created-At':new Date().toISOString()});
      return {status:res.status,data:await res.json()};
    }
    const photo=await uploadFile();assert.equal(photo.status,201);
    const photoRetry=await uploadFile();assert.deepEqual(photoRetry,photo);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(db.prepare('SELECT COUNT(*) as n FROM attachments').get()?.n,1);
    assert.equal(fs.readdirSync(upload).length,1);
    assert.equal((await uploadFile('wrong-visit')).status,409); // same operation, changed payload
    // Nested business failure cannot leave a successful replay receipt or partial write.
    assert.throws(()=>withTransaction(db,()=>{withTransaction(db,()=>db.prepare("UPDATE orders SET title='rollback' WHERE id=?").run(id));throw new Error('rollback');}));
    assert.equal(db.prepare('SELECT title FROM orders WHERE id=?').get(id)?.title,'First editor');
  } finally {
    db.close();process.env.UPLOAD_DIR=oldUpload;
    // Delete only the exact files in this test-owned directory.
    for(const name of fs.readdirSync(upload))fs.unlinkSync(path.join(upload,name));fs.rmdirSync(upload);
  }
});
