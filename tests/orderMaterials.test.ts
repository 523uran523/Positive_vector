import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { inject } from './httpHarness.ts';

test('duplicate material plans are refused and historical duplicate rows display their sum',async()=>{
  const db=openDatabase(':memory:');runMigrations(db);const app=createApp(db);let cookie='',csrf='';
  async function call(method:string,url:string,body?:unknown) {
    const res=await inject(app,method,url,body===undefined?undefined:JSON.stringify(body),{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf});
    return {res,status:res.status,data:await res.json()};
  }
  try {
    const setup=await call('POST','/api/auth/setup',{login:'admin',password:'long-password-123',fullName:'Admin'});
    cookie=setup.res.headers.get('set-cookie')!.split(';')[0];csrf=setup.data.csrfToken;
    const material=await call('POST','/api/warehouse/materials',{name:'Ткань',unit:'м',initialQtyMilli:0,purchasePriceKopecks:100});
    const id=material.data.material.id, duplicate=[{materialId:id,qtyMilli:1000},{materialId:id,qtyMilli:2000}];
    assert.equal((await call('POST','/api/orders',{title:'Дубль',plannedMaterials:duplicate})).status,400);
    const order=await call('POST','/api/orders',{title:'Заказ'});const orderId=order.data.order.id;
    assert.equal((await call('PATCH',`/api/orders/${orderId}`,{plannedMaterials:duplicate})).status,400);
    const now=new Date().toISOString();
    const stmt=db.prepare("INSERT INTO order_planned_resources(id,order_id,item_type,material_id,planned_qty_milli,created_by,created_at) VALUES (?,?,'material',?,?,?,?)");
    stmt.run('old1',orderId,id,1000,setup.data.user.id,now);stmt.run('old2',orderId,id,2000,setup.data.user.id,now);
    const loaded=await call('GET',`/api/orders/${orderId}`);
    assert.equal(loaded.data.order.plannedResources.length,1);
    assert.equal(loaded.data.order.plannedResources[0].planned_qty_milli,3000);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM order_planned_resources WHERE order_id=?').get(orderId) as any).n,2);
  } finally {db.close();}
});
