import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createApp} from '../server/app.ts';
import {openDatabase,runMigrations} from '../server/db.ts';
import {inject} from './httpHarness.ts';

test('cancelling preserves material and payment history and exposes a review only to admins',async()=>{
  const db=openDatabase(':memory:');runMigrations(db);const app=createApp(db);let cookie='',csrf='';
  async function call(method:string,url:string,body?:unknown){const res=await inject(app,method,url,body===undefined?undefined:JSON.stringify(body),{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf});return {status:res.status,res,data:await res.json()};}
  try {
    const auth=await call('POST','/api/auth/setup',{login:'admin',password:'long-password-123',fullName:'Admin'});
    cookie=auth.res.headers.get('set-cookie')!.split(';')[0];csrf=auth.data.csrfToken;
    const mat=await call('POST','/api/warehouse/materials',{name:'Ткань',unit:'м',initialQtyMilli:10000,purchasePriceKopecks:100});
    const created=await call('POST','/api/orders',{title:'Заказ'});const id=created.data.order.id;
    assert.equal((await call('POST',`/api/orders/${id}/resources`,{itemType:'material',opType:'issue',materialId:mat.data.material.id,qtyMilli:3000})).status,201);
    assert.equal((await call('POST','/api/finance/payments',{orderId:id,amountKopecks:50000,paymentType:'advance',paymentMethod:'cash'})).status,201);
    const cancel=await call('PATCH',`/api/orders/${id}`,{status:'cancelled'});
    assert.equal(cancel.data.order.cancellationIssues.materials[0].unconsumedIssuedMilli,3000);
    assert.equal(cancel.data.order.cancellationIssues.paymentsKopecks,50000);
    const reviewed=await call('POST',`/api/orders/${id}/cancellation-review`,{issueKey:'payments',note:'Возврат согласован'});
    assert.equal(reviewed.data.order.cancellationIssues.reviews[0].note,'Возврат согласован');
    await call('POST','/api/finance/payments',{orderId:id,amountKopecks:10000,paymentType:'partial',paymentMethod:'cash'});
    assert.equal((await call('GET',`/api/orders/${id}`)).data.order.cancellationIssues.reviews.length,0,'new money requires a fresh review');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM client_payments WHERE order_id=?').get(id) as any).n,2);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM warehouse_operations WHERE order_id=?').get(id) as any).n,1);
  } finally {db.close();}
});
