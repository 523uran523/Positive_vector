import type { DatabaseSync } from 'node:sqlite';

/** Planned quantities still needed on open orders. Actual stock changes only on issue/consumption. */
export function reservationsFor(db:DatabaseSync, type:'material'|'tool', itemId:string, excludeOrderId?:string|null) {
  const itemColumn=type==='material'?'material_id':'tool_id';
  const plans=db.prepare(`SELECT p.order_id,SUM(p.planned_qty_milli) AS qty FROM order_planned_resources p JOIN orders o ON o.id=p.order_id WHERE p.item_type=? AND p.${itemColumn}=? AND o.status NOT IN ('cancelled','completed') GROUP BY p.order_id`).all(type,itemId) as Array<{order_id:string;qty:number}>;
  const movement=db.prepare(`SELECT order_id,op_type,qty_milli,stock_delta_milli FROM warehouse_operations WHERE item_type=? AND ${itemColumn}=? AND order_id IS NOT NULL`).all(type,itemId) as Array<{order_id:string;op_type:string;qty_milli:number;stock_delta_milli:number|null}>;
  const byOrder=plans.map(plan=>{
    const ops=movement.filter(row=>row.order_id===plan.order_id);
    const value=(op:string,legacyOnly=false)=>ops.filter(row=>row.op_type===op && (!legacyOnly || row.stock_delta_milli===null)).reduce((sum,row)=>sum+row.qty_milli,0);
    const taken=Math.max(0,value('issue')-value('return'));
    const legacy= Math.max(0,value('issue',true)-value('return',true),value('consume',true));
    const delta=ops.filter(row=>row.stock_delta_milli!==null).reduce((sum,row)=>sum-Number(row.stock_delta_milli),0);
    const fulfilled=type==='material'?Math.max(0,legacy+delta):taken;
    return {orderId:plan.order_id,plannedMilli:plan.qty,remainingMilli:Math.max(0,plan.qty-fulfilled)};
  });
  return {byOrder,totalMilli:byOrder.reduce((n,r)=>n+r.remainingMilli,0),otherMilli:byOrder.filter(r=>r.orderId!==excludeOrderId).reduce((n,r)=>n+r.remainingMilli,0)};
}

export function ensureReservationAcknowledged(db:DatabaseSync,type:'material'|'tool',itemId:string,stockAfterMilli:number,orderId:string|null|undefined,confirmed:boolean|undefined) {
  const reservedOther=reservationsFor(db,type,itemId,orderId).otherMilli;
  if(reservedOther>stockAfterMilli && !confirmed) throw new Error('Часть остатка зарезервирована для других заказов. Подтвердите выдачу с учётом резерва.');
}
