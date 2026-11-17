import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase, runMigrations } from '../server/db.ts';
import { createReportsRouter } from '../server/routes/reports.ts';
import { createWarehouseRouter } from '../server/routes/warehouse.ts';
import { createOrdersRouter } from '../server/routes/orders.ts';

// Run the real route middleware against SQLite without opening network sockets.
function invoke(router: any, method: string, route: string, request: any) {
  const layer = router.stack.find((l: any) => l.route?.path === route && l.route.methods[method]);
  assert.ok(layer, route);
  let status = 200;
  let data: any;
  const res: any = { status(n: number) { status = n; return res; }, json(value: any) { data = value; return res; } };
  const req = { params: {}, query: {}, body: {}, ...request };
  let i = 0;
  const next = () => { const handler = layer.route.stack[i++]; if (handler) handler.handle(req, res, next); };
  next();
  return { status, data };
}

test('report scope precedes limit and hides other employees rates', () => {
  const db = openDatabase(':memory:');
  try {
    runMigrations(db);
    const now = '2026-01-01T00:00:00Z';
    for (const id of ['one', 'two']) db.prepare("INSERT INTO users (id,login,password_hash,role,full_name,created_at,updated_at) VALUES (?,?,?,'employee',?,?,?)").run(id,id,'unused',id,now,now);
    const insert = db.prepare("INSERT INTO workshop_shifts (id,user_id,started_at,ended_at,status,rate_snapshot_kopecks,created_at) VALUES (?,?,?,?,'completed',123456,?)");
    insert.run('own','one',now,now,now);
    for(let i=0;i<301;i++) insert.run(`other-${i}`,'two','2026-02-01','2026-02-02',now);
    const router = createReportsRouter(db);
    const employee = { id: 'one', role: 'employee', permissions: {} };
    const own = invoke(router,'get','/',{authUser:employee,query:{userId:'two'}});
    assert.equal(own.data.shiftReports.length,1);
    assert.equal(own.data.shiftReports[0].id,'own');
    const shared = invoke(router,'get','/',{authUser:{...employee,permissions:{'reports.view_others':true}},query:{userId:'two'}});
    assert.equal(shared.data.shiftReports.length,300);
    assert.equal('rate_snapshot_kopecks' in shared.data.shiftReports[0],false);
    assert.equal(invoke(router,'get','/',{}).status,401);
  } finally { db.close(); }
});

test('new destructive routes reject unauthorised users', () => {
  const db = openDatabase(':memory:');
  try {
    runMigrations(db);
    const employee = { id:'employee', role:'employee', permissions:{} };
    assert.equal(invoke(createOrdersRouter(db),'delete','/:id',{authUser:employee}).status,403);
    assert.equal(invoke(createWarehouseRouter(db),'delete','/materials/:id',{authUser:employee}).status,403);
    assert.equal(invoke(createWarehouseRouter(db),'delete','/tools/:id',{authUser:employee}).status,403);
  } finally { db.close(); }
});
