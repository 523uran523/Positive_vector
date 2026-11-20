import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

type Batch = {id:string;remaining_qty_milli:number;unit_cost_kopecks:number};
type IssueAllocation = {id:string;batch_id:string;unsettled_milli:number;unit_cost_kopecks:number};

/** All helpers run inside the caller's stock movement transaction. */
export function createBatch(db:DatabaseSync, materialId:string, operationId:string|null, qty:number, remaining:number, cost:number, estimated:boolean, now:string) {
  const id=crypto.randomUUID();
  db.prepare('INSERT INTO material_batches(id,material_id,source_operation_id,received_qty_milli,remaining_qty_milli,unit_cost_kopecks,estimated,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,materialId,operationId,qty,remaining,cost,estimated?1:0,now);
  return id;
}

function allocation(db:DatabaseSync, operationId:string, batchId:string, qty:number, unsettled:number) {
  db.prepare('INSERT INTO material_batch_allocations(id,operation_id,batch_id,qty_milli,unsettled_milli) VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(),operationId,batchId,qty,unsettled);
}

export function takeStock(db:DatabaseSync, materialId:string, operationId:string, qty:number, issue:boolean):number {
  const batches=db.prepare('SELECT id,remaining_qty_milli,unit_cost_kopecks FROM material_batches WHERE material_id=? AND remaining_qty_milli>0 ORDER BY seq').all(materialId) as Batch[];
  let left=qty, value=0;
  for(const batch of batches) {
    const take=Math.min(left,batch.remaining_qty_milli); if(!take) continue;
    db.prepare('UPDATE material_batches SET remaining_qty_milli=remaining_qty_milli-? WHERE id=?').run(take,batch.id);
    allocation(db,operationId,batch.id,take,issue?take:0);
    value+=take*batch.unit_cost_kopecks; left-=take;
    if(!left) break;
  }
  if(left) throw new Error('Не удалось определить партии для всего остатка. Обратитесь к администратору.');
  return value;
}

export function settleIssued(db:DatabaseSync, materialId:string, operationId:string, orderId:string|null, qty:number, isReturn:boolean, legacyOutstanding:number, legacyCost:number, now:string):number {
  let left=qty, value=0;
  // Existing issued stock has no trustworthy batch assignment. Keep it explicitly estimated.
  const legacy=Math.min(left,Math.max(0,legacyOutstanding));
  if(legacy) {
    let remaining=legacy;
    const rows=db.prepare(`SELECT order_key,remaining_milli FROM material_legacy_issued WHERE material_id=? AND remaining_milli>0 ${orderId ? 'AND order_key=?' : ''} ORDER BY order_key`).all(...(orderId ? [materialId,orderId] : [materialId])) as Array<{order_key:string;remaining_milli:number}>;
    for(const row of rows) {
      const used=Math.min(remaining,row.remaining_milli);
      db.prepare('UPDATE material_legacy_issued SET remaining_milli=remaining_milli-? WHERE material_id=? AND order_key=?').run(used,materialId,row.order_key);
      remaining-=used; if(!remaining) break;
    }
    if(remaining) throw new Error('Не удалось определить остаток ранее выданного материала.');
    const id=createBatch(db,materialId,null,legacy,isReturn?legacy:0,legacyCost,true,now);
    allocation(db,operationId,id,legacy,0); value+=legacy*legacyCost; left-=legacy;
  }
  const where=orderId ? 'AND o.order_id = ?' : '';
  const params=orderId ? [materialId,orderId] : [materialId];
  const rows=db.prepare(`SELECT a.id,a.batch_id,a.unsettled_milli,b.unit_cost_kopecks FROM material_batch_allocations a JOIN warehouse_operations o ON o.id=a.operation_id JOIN material_batches b ON b.id=a.batch_id WHERE o.material_id=? AND o.op_type='issue' AND a.unsettled_milli>0 ${where} ORDER BY o.created_at,a.rowid`).all(...params) as IssueAllocation[];
  for(const row of rows) {
    const take=Math.min(left,row.unsettled_milli); if(!take) continue;
    db.prepare('UPDATE material_batch_allocations SET unsettled_milli=unsettled_milli-? WHERE id=?').run(take,row.id);
    if(isReturn) db.prepare('UPDATE material_batches SET remaining_qty_milli=remaining_qty_milli+? WHERE id=?').run(take,row.batch_id);
    allocation(db,operationId,row.batch_id,take,0); value+=take*row.unit_cost_kopecks; left-=take;
    if(!left) break;
  }
  if(left) throw new Error('Не удалось определить партию выданного материала.');
  return value;
}

export function legacyOutstanding(db:DatabaseSync, materialId:string, orderId:string|null):number {
  const row=db.prepare(`SELECT COALESCE(SUM(remaining_milli),0) AS qty FROM material_legacy_issued WHERE material_id=? ${orderId ? 'AND order_key=?' : ''}`).get(...(orderId ? [materialId,orderId] : [materialId])) as {qty:number};
  return row.qty;
}

export function trackedOutstanding(db:DatabaseSync, materialId:string, orderId:string|null):number {
  const where=orderId ? 'AND o.order_id=?' : '';
  const params=orderId ? [materialId,orderId] : [materialId];
  const row=db.prepare(`SELECT COALESCE(SUM(a.unsettled_milli),0) AS qty FROM material_batch_allocations a JOIN warehouse_operations o ON o.id=a.operation_id WHERE o.material_id=? AND o.op_type='issue' ${where}`).get(...params) as {qty:number};
  return row.qty;
}
