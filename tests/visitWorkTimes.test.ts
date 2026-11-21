import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { inject } from './httpHarness.ts';

test('each installer records independent work times and only sees their own', async () => {
  const db = openDatabase(':memory:'); runMigrations(db); const app = createApp(db);
  let cookie = '', csrf = '';
  const call = async (method:string, url:string, body?:unknown) => {
    const res = await inject(app,method,url,body === undefined ? undefined : JSON.stringify(body),{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf});
    return { res, status:res.status, data:(res.headers.get('content-type') || '').includes('json') ? await res.json() : null };
  };
  try {
    const admin=await call('POST','/api/auth/setup',{login:'admin',password:'long-password-123',fullName:'Admin'});
    cookie=admin.res.headers.get('set-cookie')!.split(';')[0]; csrf=admin.data.csrfToken;
    const adminCookie=cookie, adminCsrf=csrf;
    const a=await call('POST','/api/users',{login:'worker-a',fullName:'Worker A',password:'long-password-123'});
    const b=await call('POST','/api/users',{login:'worker-b',fullName:'Worker B',password:'long-password-123'});
    const order=await call('POST','/api/orders',{title:'Монтаж',assigneeIds:[a.data.user.id,b.data.user.id],visits:[{title:'Выезд',scheduledAt:'2026-11-21T10:00',assigneeIds:[a.data.user.id,b.data.user.id]}]});
    const url=`/api/orders/${order.data.order.id}/visits/${order.data.order.visits[0].id}`;
    for (const [login,start,end] of [['worker-a','09:00','17:00'],['worker-b','10:00','18:30']]) {
      const session=await call('POST','/api/auth/login',{login,password:'long-password-123'});
      cookie=session.res.headers.get('set-cookie')!.split(';')[0]; csrf=session.data.csrfToken;
      assert.equal((await call('PUT',`${url}/work-time`,{workDate:'2026-11-21',startTime:start,endTime:end})).status,200);
      const own=await call('GET',`${url}/work-times`);
      assert.equal(own.data.items.length,1); assert.equal(own.data.items[0].start_time,start);
      assert.equal((await call('PUT',`${url}/work-time`,{workDate:'2026-02-30',startTime:start,endTime:end})).status,400);
    }
    cookie=adminCookie; csrf=adminCsrf;
    const all=await call('GET',`${url}/work-times`);
    assert.equal(all.data.items.length,2);
    assert.deepEqual(all.data.items.map((item:{start_time:string})=>item.start_time).sort(),['09:00','10:00']);
  } finally { db.close(); }
});
