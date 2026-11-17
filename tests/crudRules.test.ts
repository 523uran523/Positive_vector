import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { inject } from './httpHarness.ts';

test('financial corrections recalculate totals and protect history; deleting last report reopens work',async()=>{
  const db=openDatabase(':memory:');runMigrations(db);const app=createApp(db);
  let cookie='',csrf='';
  async function call(method:string,url:string,body?:unknown){
    const res=await inject(app,method,url,body===undefined?undefined:JSON.stringify(body),{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf});
    return {res,status:res.status,data:await res.json()};
  }
  try {
    const setup=await call('POST','/api/auth/setup',{login:'admin',password:'long-password-123',fullName:'Admin'});
    cookie=setup.res.headers.get('set-cookie')!.split(';')[0];csrf=setup.data.csrfToken;
    const company=await call('POST','/api/clients/companies',{name:'Company'});assert.equal(company.status,201);
    const companyId=company.data.company.id;
    const order=await call('POST','/api/orders',{title:'Financial corrections',priceKopecks:10000,companyId,visits:[{title:'Visit',scheduledAt:'2026-11-18T10:00:00Z'}]});assert.equal(order.status,201);
    const orderId=order.data.order.id;
    const tool=await call('POST','/api/warehouse/tools',{name:'Drill',trackingMode:'quantity',totalQty:3});assert.equal(tool.status,201);
    const toolId=tool.data.tool.id;
    const planned=await call('PATCH',`/api/orders/${orderId}`,{plannedTools:[{toolId,qty:2}]});assert.equal(planned.status,200);
    assert.equal(planned.data.order.plannedResources[0].planned_qty_milli,2000);
    assert.equal(db.prepare('SELECT available_qty FROM tools WHERE id=?').get(toolId)?.available_qty,3,'planning does not issue stock');
    assert.equal((await call('DELETE',`/api/clients/companies/${companyId}`,{})).status,409);
    const payment=await call('POST','/api/finance/payments',{orderId,amountKopecks:4000,paymentType:'partial',paymentMethod:'bank'});assert.equal(payment.status,201);
    const expense=await call('POST','/api/finance/expenses',{orderId,category:'fuel',amountKopecks:1000});assert.equal(expense.status,201);
    let summary=(await call('GET','/api/finance/overview')).data;
    assert.equal(summary.metrics.totalReceivedCashKopecks,4000);assert.equal(summary.metrics.totalExpensesRecordedKopecks,1000);
    assert.equal((await call('PATCH',`/api/finance/payments/${payment.data.id}`,{amountKopecks:6000})).status,200);
    assert.equal((await call('PATCH',`/api/finance/expenses/${expense.data.id}`,{amountKopecks:2000})).status,200);
    summary=(await call('GET','/api/finance/overview')).data;
    assert.equal(summary.metrics.totalReceivedCashKopecks,6000);assert.equal(summary.metrics.totalExpensesRecordedKopecks,2000);
    assert.equal((await call('PATCH',`/api/finance/expenses/${expense.data.id}`,{amountKopecks:0.5})).status,400);
    assert.equal((await call('DELETE',`/api/orders/${orderId}`,{})).status,409);
    assert.equal((await call('DELETE',`/api/finance/payments/${payment.data.id}`,{})).status,200);
    assert.equal((await call('DELETE',`/api/finance/expenses/${expense.data.id}`,{})).status,200);
    summary=(await call('GET','/api/finance/overview')).data;
    assert.equal(summary.metrics.totalReceivedCashKopecks,0);assert.equal(summary.metrics.totalExpensesRecordedKopecks,0);
    const visitId=order.data.order.visits[0].id;
    const report=await call('POST',`/api/orders/${orderId}/visits/${visitId}/report`,{workDone:'Done',completeVisit:true});assert.equal(report.status,201);
    assert.equal(report.data.order.status,'completed');
    const removed=await call('DELETE',`/api/orders/${orderId}/visits/${visitId}/reports/${report.data.reportId}`,{});
    assert.equal(removed.status,200);assert.equal(removed.data.order.status,'in_progress');assert.equal(removed.data.order.visits[0].status,'planned');
    const audit=(await call('GET','/api/settings/audit-log')).data.logs;
    for(const action of ['payment_updated','expense_updated','payment_deleted','expense_deleted','report_deleted']) assert.ok(audit.some((log:any)=>log.action===action),action);
  } finally {db.close();}
});
