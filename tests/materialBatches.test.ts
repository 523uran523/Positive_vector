import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase, runMigrations, withTransaction } from '../server/db.ts';
import { applyMaterialOperationTx } from '../server/services/warehouseService.ts';
import fs from 'node:fs';
import path from 'node:path';

test('FIFO purchases, issue, consumption, return and insufficient stock', () => {
  const db=openDatabase(':memory:'); runMigrations(db);
  try {
    const now=new Date().toISOString();
    db.prepare("INSERT INTO users(id,login,password_hash,role,full_name,created_at,updated_at) VALUES ('u','u','x','admin','Admin',?,?)").run(now,now);
    db.prepare("INSERT INTO materials(id,name,category,unit,quantity_milli,purchase_price_kopecks,min_threshold_milli,created_at) VALUES ('m','Material','Other','шт',0,0,0,?)").run(now);
    db.prepare("INSERT INTO orders(id,order_number,title,created_by,created_at,updated_at) VALUES ('o','1','Order','u',?,?)").run(now,now);
    const move=(opType:'receipt'|'issue'|'consume'|'return',qty:number,cost?:number,orderId?:string) => withTransaction(db,()=>applyMaterialOperationTx(db,{materialId:'m',opType,qtyMilli:qty*1000,unitCostKopecks:cost,orderId,actorUserId:'u'}));
    move('receipt',100,1000); move('receipt',20,500);
    const issue=move('issue',100,undefined,'o');
    let lots=db.prepare('SELECT remaining_qty_milli,unit_cost_kopecks FROM material_batches ORDER BY seq').all();
    assert.deepEqual(lots.map(x=>[x.remaining_qty_milli,x.unit_cost_kopecks]),[[0,1000],[20000,500]]);
    assert.equal((db.prepare('SELECT unit_cost_kopecks FROM warehouse_operations WHERE id=?').get(issue.operationId) as any).unit_cost_kopecks,1000);
    const returned=move('return',30,undefined,'o');
    assert.equal((db.prepare('SELECT unit_cost_kopecks FROM warehouse_operations WHERE id=?').get(returned.operationId) as any).unit_cost_kopecks,1000);
    const consumed=move('consume',70,undefined,'o');
    assert.equal((db.prepare('SELECT unit_cost_kopecks FROM warehouse_operations WHERE id=?').get(consumed.operationId) as any).unit_cost_kopecks,1000);
    lots=db.prepare('SELECT remaining_qty_milli,unit_cost_kopecks FROM material_batches ORDER BY seq').all();
    assert.deepEqual(lots.map(x=>[x.remaining_qty_milli,x.unit_cost_kopecks]),[[30000,1000],[20000,500]]);
    assert.throws(()=>move('consume',51),/Недостаточно/);
    assert.equal((db.prepare("SELECT quantity_milli FROM materials WHERE id='m'").get() as any).quantity_milli,50000);
    const mixed=move('consume',40);
    const value=db.prepare('SELECT SUM(a.qty_milli*b.unit_cost_kopecks)/1000 AS cost FROM material_batch_allocations a JOIN material_batches b ON b.id=a.batch_id WHERE a.operation_id=?').get(mixed.operationId) as {cost:number};
    assert.equal(value.cost,35000);
    move('receipt',20,750);
    move('consume',5,undefined,'o'); // direct consumption after the previous issue was exhausted
    move('issue',10,undefined,'o');
    const laterReturn=move('return',10,undefined,'o');
    assert.equal(laterReturn.newStockMilli,25000);
  } finally { db.close(); }
});

test('migration preserves old stock and marks unknown historical costs as estimates', () => {
  const db=openDatabase(':memory:');
  try {
    for(const file of ['001_init.sql','002_sync.sql','003_chat.sql','004_chat_rooms.sql','005_dismissals_and_chat_archive.sql','006_quick_tasks.sql','007_accounting_documents.sql']) db.exec(fs.readFileSync(path.resolve('server/migrations',file),'utf8'));
    const now='2026-01-01T10:00:00.000Z';
    db.prepare("INSERT INTO users(id,login,password_hash,role,full_name,created_at,updated_at) VALUES ('u','u','x','admin','Admin',?,?)").run(now,now);
    db.prepare("INSERT INTO materials(id,name,category,unit,quantity_milli,purchase_price_kopecks,min_threshold_milli,created_at) VALUES ('m','Material','Other','шт',5000,700,0,?)").run(now);
    db.prepare("INSERT INTO orders(id,order_number,title,created_by,created_at,updated_at) VALUES ('o','1','Order','u',?,?)").run(now,now);
    db.prepare("INSERT INTO warehouse_operations(id,item_type,material_id,op_type,qty_milli,unit_cost_kopecks,order_id,user_id,created_at) VALUES ('old','material','m','issue',3000,400,'o','u',?)").run(now);
    db.exec(fs.readFileSync(path.resolve('server/migrations/008_warehouse_batches.sql'),'utf8'));
    db.exec(fs.readFileSync(path.resolve('server/migrations/010_stock_deltas.sql'),'utf8'));
    const opening=db.prepare('SELECT remaining_qty_milli,estimated FROM material_batches').get() as any;
    assert.equal(opening.remaining_qty_milli,5000); assert.equal(opening.estimated,1);
    withTransaction(db,()=>applyMaterialOperationTx(db,{materialId:'m',opType:'return',qtyMilli:2000,orderId:'o',actorUserId:'u'}));
    const returned=db.prepare("SELECT b.estimated,b.remaining_qty_milli FROM material_batches b JOIN material_batch_allocations a ON a.batch_id=b.id JOIN warehouse_operations o ON o.id=a.operation_id WHERE o.op_type='return'").get() as any;
    assert.equal(returned.estimated,1); assert.equal(returned.remaining_qty_milli,2000);
    assert.equal((db.prepare("SELECT qty_milli FROM warehouse_operations WHERE id='old'").get() as any).qty_milli,3000);
  } finally {db.close();}
});
