import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase,runMigrations,withTransaction } from '../server/db.ts';
import { applyMaterialOperationTx } from '../server/services/warehouseService.ts';
import { reservationsFor } from '../server/services/reservations.ts';
import { createApp } from '../server/app.ts';
import { inject } from './httpHarness.ts';

test('plans reserve stock without issuing, shortages may be confirmed and cancellation releases reservation',()=>{
  const db=openDatabase(':memory:');runMigrations(db);
  try {
    const now=new Date().toISOString();
    db.prepare("INSERT INTO users(id,login,password_hash,role,full_name,created_at,updated_at) VALUES ('u','u','x','admin','Admin',?,?)").run(now,now);
    db.prepare("INSERT INTO materials(id,name,category,unit,quantity_milli,purchase_price_kopecks,min_threshold_milli,created_at) VALUES ('m','Ткань','Other','м',0,0,0,?)").run(now);
    for(const id of ['a','b']) db.prepare('INSERT INTO orders(id,order_number,title,created_by,created_at,updated_at) VALUES (?,?,?,\'u\',?,?)').run(id,id,id,now,now);
    const move=(opType:'receipt'|'issue'|'return',qty:number,orderId?:string,confirmReserved?:boolean)=>withTransaction(db,()=>applyMaterialOperationTx(db,{materialId:'m',opType,qtyMilli:qty*1000,unitCostKopecks:500,orderId,actorUserId:'u',confirmReserved}));
    move('receipt',10);
    for(const id of ['a','b']) db.prepare("INSERT INTO order_planned_resources(id,order_id,item_type,material_id,planned_qty_milli,created_by,created_at) VALUES (?,?,'material','m',8000,'u',?)").run(`p${id}`,id,now);
    assert.equal(reservationsFor(db,'material','m').totalMilli,16000);
    assert.equal((db.prepare("SELECT quantity_milli FROM materials WHERE id='m'").get() as any).quantity_milli,10000);
    assert.throws(()=>move('issue',3,'b'),/зарезервирована/);
    assert.equal((db.prepare("SELECT quantity_milli FROM materials WHERE id='m'").get() as any).quantity_milli,10000);
    move('issue',3,'b',true);
    assert.equal(reservationsFor(db,'material','m').totalMilli,13000);
    move('return',2,'b');assert.equal(reservationsFor(db,'material','m').totalMilli,15000);
    db.prepare("UPDATE orders SET status='cancelled' WHERE id='a'").run();
    assert.equal(reservationsFor(db,'material','m').totalMilli,7000);
  } finally {db.close();}
});

test('warehouse issue and return require an accessible order',async()=>{
  const db=openDatabase(':memory:');runMigrations(db);const app=createApp(db);let cookie='',csrf='';
  async function call(method:string,url:string,body?:unknown){const res=await inject(app,method,url,body===undefined?undefined:JSON.stringify(body),{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf});return {status:res.status,res,data:await res.json()};}
  try {
    const login=await call('POST','/api/auth/setup',{login:'admin',password:'long-password-123',fullName:'Admin'});cookie=login.res.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrfToken;
    const material=(await call('POST','/api/warehouse/materials',{name:'Ткань',unit:'м',initialQtyMilli:10000,purchasePriceKopecks:100})).data.material;
    const url=`/api/warehouse/materials/${material.id}/operations`;
    assert.equal((await call('POST',url,{opType:'issue',qtyMilli:1000})).status,400);
    assert.equal((await call('POST',url,{opType:'return',qtyMilli:1000})).status,400);
    const order=(await call('POST','/api/orders',{title:'Тест'})).data.order;
    assert.equal((await call('POST',url,{opType:'issue',qtyMilli:1000,orderId:order.id})).status,201);
    assert.equal((await call('POST',url,{opType:'return',qtyMilli:1000,orderId:order.id})).status,201);
  } finally {db.close();}
});
