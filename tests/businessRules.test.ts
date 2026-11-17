import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import * as XLSX from 'xlsx';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { inject } from './httpHarness.ts';
let testApp: ReturnType<typeof createApp>;
const fetch = (url: string, options: {method:string;headers:Record<string,string>;body?:string}) =>
  process.env.PV_TEST_HTTP === '1' ? globalThis.fetch(url,options) : inject(testApp,options.method,new URL(url).pathname,options.body,options.headers);

interface ApiClient {
  cookie: string;
  csrfToken: string;
}

async function reqJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  client?: ApiClient
): Promise<{ status: number; data: Record<string, any>; setCookie?: string; rawBuffer?: Buffer }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (client?.cookie) headers['Cookie'] = client.cookie;
  if (client?.csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    headers['X-CSRF-Token'] = client.csrfToken;
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const setCookie = res.headers.get('set-cookie') || undefined;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = (await res.json()) as Record<string, any>;
    return { status: res.status, data, setCookie };
  }
  const ab = await res.arrayBuffer();
  return { status: res.status, data: {}, setCookie, rawBuffer: Buffer.from(ab) };
}

describe('Позитив Вектор CRM/ERP — бизнес-логика и безопасность', () => {
  let db: ReturnType<typeof openDatabase>;
  let server: http.Server | undefined;
  let baseUrl = '';
  const adminClient: ApiClient = { cookie: '', csrfToken: '' };
  const empClient: ApiClient = { cookie: '', csrfToken: '' };
  let empId = '';
  let emp2Id = '';
  let empTempPass = '';

  before(async () => {
    db = openDatabase(':memory:');
    runMigrations(db);
    testApp = createApp(db);
    baseUrl = 'http://in-process';
    if(process.env.PV_TEST_HTTP === '1') {
      await new Promise<void>((resolve,reject)=>{
        server=testApp.listen(0,'127.0.0.1',()=>{
          baseUrl=`http://127.0.0.1:${(server!.address() as {port:number}).port}`;resolve();
        });
        server.once('error',reject);
      });
    }
  });

  after(async () => {
    if(server?.listening) await new Promise<void>(resolve=>server!.close(()=>resolve()));
    db.close();
  });

  it('1. Первичная настройка администратора, авторизация, CSRF-защита и блокировка подбора пароля', async () => {
    const status0 = await reqJson(baseUrl, 'GET', '/api/auth/status');
    assert.equal(status0.status, 200);
    assert.equal(status0.data.needsSetup, true);

    const setup = await reqJson(baseUrl, 'POST', '/api/auth/setup', {
      login: 'owner',
      fullName: 'Главный Администратор',
      autoGenerate: true,
    });
    assert.equal(setup.status, 201);
    assert.ok(setup.data.generatedCredentials.temporaryPassword);
    assert.ok(setup.setCookie);
    adminClient.cookie = setup.setCookie.split(';')[0];
    adminClient.csrfToken = setup.data.csrfToken;

    // Second setup attempt must fail
    const setupAgain = await reqJson(baseUrl, 'POST', '/api/auth/setup', {
      login: 'hacker',
      password: 'password123',
    });
    assert.equal(setupAgain.status, 409);

    // CSRF rejection without header
    const noCsrf = await reqJson(baseUrl, 'POST', '/api/users', { login: 'u1', fullName: 'Тест' }, {
      cookie: adminClient.cookie,
      csrfToken: '',
    });
    assert.equal(noCsrf.status, 403);

    // Admin creates two employees
    const createEmp = await reqJson(
      baseUrl,
      'POST',
      '/api/users',
      {
        login: 'installer1',
        fullName: 'Иванов Монтажник',
        shiftRateKopecks: 300000,
        permissions: {
          'orders.edit_assigned': true,
          'warehouse.take': true,
          'clients.view_all': true,
        },
      },
      adminClient
    );
    assert.equal(createEmp.status, 201);
    empId = createEmp.data.user.id;
    empTempPass = createEmp.data.temporaryPassword;

    const createEmp2 = await reqJson(
      baseUrl,
      'POST',
      '/api/users',
      {
        login: 'installer2',
        fullName: 'Петров Монтажник',
        shiftRateKopecks: 280000,
      },
      adminClient
    );
    assert.equal(createEmp2.status, 201);
    emp2Id = createEmp2.data.user.id;

    // Rate limiting lockout after 5 wrong attempts on installer2
    for (let i = 0; i < 5; i++) {
      const bad = await reqJson(baseUrl, 'POST', '/api/auth/login', {
        login: 'installer2',
        password: 'wrong-password',
      });
      assert.equal(bad.status, 401);
    }
    const locked = await reqJson(baseUrl, 'POST', '/api/auth/login', {
      login: 'installer2',
      password: createEmp2.data.temporaryPassword,
    });
    assert.equal(locked.status, 429);

    // Employee 1 logs in
    const loginEmp = await reqJson(baseUrl, 'POST', '/api/auth/login', {
      login: 'installer1',
      password: empTempPass,
    });
    assert.equal(loginEmp.status, 200);
    empClient.cookie = loginEmp.setCookie!.split(';')[0];
    empClient.csrfToken = loginEmp.data.csrfToken;

    // Employee MUST NOT access finance, summary salaries, or DB export
    const fin = await reqJson(baseUrl, 'GET', '/api/finance/overview', undefined, empClient);
    assert.equal(fin.status, 403);
    const sal = await reqJson(baseUrl, 'GET', '/api/salaries/summary', undefined, empClient);
    assert.equal(sal.status, 403);
    const exp = await reqJson(baseUrl, 'GET', '/api/export/database.xlsx', undefined, empClient);
    assert.equal(exp.status, 403);
  });

  it('2. Многодневный заказ автозавершается только после отчётов по ВСЕМ выездам и скрывает цену от сотрудника', async () => {
    const comp = await reqJson(
      baseUrl,
      'POST',
      '/api/clients/companies',
      { name: 'ООО Реклама Плюс', phone: '+7 900 111-22-33' },
      adminClient
    );
    assert.equal(comp.status, 201);
    const companyId = comp.data.company.id;

    // Create order WITHOUT visits -> stays new
    const ordRes = await reqJson(
      baseUrl,
      'POST',
      '/api/orders',
      {
        orderNumber: 'ПВ-9001',
        title: 'Световой короб 4×1 м',
        companyId,
        priceKopecks: 5000000,
        assigneeIds: [empId],
        visits: [
          { title: 'День 1: Крепёж рамы', scheduledAt: '2026-05-10T10:00', assigneeIds: [empId] },
          { title: 'День 2: Монтаж короба', scheduledAt: '2026-05-11T10:00', assigneeIds: [empId] },
        ],
      },
      adminClient
    );
    assert.equal(ordRes.status, 201);
    const orderId = ordRes.data.order.id;
    const visit1Id = ordRes.data.order.visits[0].id;
    const visit2Id = ordRes.data.order.visits[1].id;

    // Employee reads order -> price_kopecks must be absent!
    const empOrd = await reqJson(baseUrl, 'GET', `/api/orders/${orderId}`, undefined, empClient);
    assert.equal(empOrd.status, 200);
    assert.equal(empOrd.data.order.price_kopecks, undefined);

    // Complete Visit 1 -> parent order becomes in_progress (NOT completed yet)
    const rep1 = await reqJson(
      baseUrl,
      'POST',
      `/api/orders/${orderId}/visits/${visit1Id}/report`,
      { startTime: '10:00', endTime: '14:00', workDone: 'Собран металлокаркас на фасаде.' },
      empClient
    );
    assert.equal(rep1.status, 201);
    assert.equal(rep1.data.order.visits[0].status, 'completed');
    assert.equal(rep1.data.order.status, 'in_progress');

    // Complete Visit 2 -> parent order auto-completes!
    const rep2 = await reqJson(
      baseUrl,
      'POST',
      `/api/orders/${orderId}/visits/${visit2Id}/report`,
      { startTime: '10:00', endTime: '16:30', workDone: 'Смонтирован световой короб, подключена подсветка.' },
      empClient
    );
    assert.equal(rep2.status, 201);
    assert.equal(rep2.data.order.visits[1].status, 'completed');
    assert.equal(rep2.data.order.status, 'completed');

    // Admin reopens order -> status returns to in_progress and audit log recorded
    const reopen = await reqJson(
      baseUrl,
      'POST',
      `/api/orders/${orderId}/reopen`,
      { reason: 'Дополнительная герметизация' },
      adminClient
    );
    assert.equal(reopen.status, 200);
    assert.equal(reopen.data.order.status, 'in_progress');

    // Admin assigns individual wage for visit 1
    const wage = await reqJson(
      baseUrl,
      'POST',
      '/api/salaries/visit-wage',
      { visitId: visit1Id, userId: empId, amountKopecks: 420000 },
      adminClient
    );
    assert.equal(wage.status, 200);

    // Employee sees 4200 RUB accrued AND visit 2 in pendingVisits
    const mySal = await reqJson(baseUrl, 'GET', '/api/salaries/my', undefined, empClient);
    assert.equal(mySal.status, 200);
    assert.equal(mySal.data.totalAccruedKopecks, 420000);
    assert.equal(mySal.data.pendingVisits.length, 1);
    assert.equal(mySal.data.pendingVisits[0].visit_id, visit2Id);
  });

  it('3. Смена в цеху: запрет второй активной смены и сохранение снимка ставки при изменении тарифа', async () => {
    const start1 = await reqJson(baseUrl, 'POST', '/api/shifts/start', {}, empClient);
    assert.equal(start1.status, 201);

    // Duplicate active shift rejected
    const startDup = await reqJson(baseUrl, 'POST', '/api/shifts/start', {}, empClient);
    assert.equal(startDup.status, 409);

    const finish = await reqJson(
      baseUrl,
      'POST',
      '/api/shifts/finish',
      { workDone: 'Раскрой баннеров и сварка рамы.' },
      empClient
    );
    assert.equal(finish.status, 200);
    assert.equal(finish.data.accruedKopecks, 300000);
    assert.equal(finish.data.shift.rate_snapshot_kopecks, 300000);

    // Admin raises employee shift rate to 4500 RUB -> historical shift accrual stays 3000 RUB
    const updRate = await reqJson(
      baseUrl,
      'PATCH',
      `/api/users/${empId}`,
      { shiftRateKopecks: 450000 },
      adminClient
    );
    assert.equal(updRate.status, 200);

    const mySal = await reqJson(baseUrl, 'GET', '/api/salaries/my', undefined, empClient);
    // 420000 (visit 1) + 300000 (shift 1) = 720000
    assert.equal(mySal.data.totalAccruedKopecks, 720000);
  });

  it('4. Склад: выдача -> списание -> возврат без двойного списания + отрицательный остаток с уведомлением', async () => {
    const matRes = await reqJson(
      baseUrl,
      'POST',
      '/api/warehouse/materials',
      {
        name: 'Саморезы 4.2×32',
        category: 'Крепёж',
        unit: 'уп',
        initialQtyMilli: 10000, // 10 уп
        purchasePriceKopecks: 50000, // 500 ₽/уп
        minThresholdMilli: 2000,
      },
      adminClient
    );
    assert.equal(matRes.status, 201);
    const matId = matRes.data.material.id;

    // Create simple order
    const ordRes = await reqJson(
      baseUrl,
      'POST',
      '/api/orders',
      { orderNumber: 'ПВ-9002', title: 'Тест склада', assigneeIds: [empId], priceKopecks: 2000000 },
      adminClient
    );
    const orderId = ordRes.data.order.id;

    // Issue 10 units to order -> stock becomes 0
    const issue = await reqJson(
      baseUrl,
      'POST',
      `/api/orders/${orderId}/resources`,
      { itemType: 'material', opType: 'issue', materialId: matId, qtyMilli: 10000 },
      empClient
    );
    assert.equal(issue.status, 201);
    assert.equal(issue.data.newStockMilli, 0);

    // Consume 6 of those 10 units -> stock stays 0 (NO double deduction!)
    const consume = await reqJson(
      baseUrl,
      'POST',
      `/api/orders/${orderId}/resources`,
      { itemType: 'material', opType: 'consume', materialId: matId, qtyMilli: 6000 },
      empClient
    );
    assert.equal(consume.status, 201);
    assert.equal(consume.data.newStockMilli, 0);

    // Return remaining 4 units -> stock becomes 4
    const ret = await reqJson(
      baseUrl,
      'POST',
      `/api/orders/${orderId}/resources`,
      { itemType: 'material', opType: 'return', materialId: matId, qtyMilli: 4000 },
      empClient
    );
    assert.equal(ret.status, 201);
    assert.equal(ret.data.newStockMilli, 4000);

    // Returning 1 more unit must fail (0 unconsumed left on order)
    const overRet = await reqJson(
      baseUrl,
      'POST',
      `/api/orders/${orderId}/resources`,
      { itemType: 'material', opType: 'return', materialId: matId, qtyMilli: 1000 },
      empClient
    );
    assert.equal(overRet.status, 400);

    // Consume 6 units directly -> stock becomes -2 (-2000 milli) & triggers admin notification
    const negConsume = await reqJson(
      baseUrl,
      'POST',
      `/api/orders/${orderId}/resources`,
      { itemType: 'material', opType: 'consume', materialId: matId, qtyMilli: 6000 },
      empClient
    );
    assert.equal(negConsume.status, 201);
    assert.equal(negConsume.data.newStockMilli, -2000);
    assert.equal(negConsume.data.negativeStockWarning, true);

    const notifs = await reqJson(baseUrl, 'GET', '/api/notifications', undefined, adminClient);
    assert.ok(notifs.data.notifications.some((n: any) => n.type === 'low_stock'));
  });

  it('5. Финансы без задвоения и XLSX-экспорт без паролей и токенов', async () => {
    // Record 25,000 RUB client payment & 1,000 RUB salary payout & 2,000 RUB fuel expense
    const pay = await reqJson(
      baseUrl,
      'POST',
      '/api/finance/payments',
      { amountKopecks: 2500000, paymentType: 'advance', paymentMethod: 'bank' },
      adminClient
    );
    assert.equal(pay.status, 201);

    const payout = await reqJson(
      baseUrl,
      'POST',
      '/api/salaries/payouts',
      { userId: empId, amountKopecks: 100000, paymentMethod: 'cash', comment: 'Частичная выплата' },
      adminClient
    );
    assert.equal(payout.status, 201);

    const exp = await reqJson(
      baseUrl,
      'POST',
      '/api/finance/expenses',
      { category: 'fuel', amountKopecks: 200000, paymentMethod: 'card', description: 'ГСМ' },
      adminClient
    );
    assert.equal(exp.status, 201);

    const ov = await reqJson(baseUrl, 'GET', '/api/finance/overview', undefined, adminClient);
    assert.equal(ov.status, 200);
    const m = ov.data.metrics;
    // Total orders: 50,000 + 20,000 = 70,000 RUB (7,000,000 kopecks)
    assert.equal(m.totalOrderPriceKopecks, 7000000);
    assert.equal(m.totalReceivedCashKopecks, 2500000);
    assert.equal(m.accruedSalariesKopecks, 720000);
    assert.equal(m.paidSalariesKopecks, 100000);
    assert.equal(m.operatingExpensesKopecks, 200000);
    // Cash Out = paidSalaries (100,000) + operatingExpenses (200,000) = 300,000 (not double counting accrued salaries!)
    assert.equal(m.cashOutKopecks, 300000);
    assert.equal(m.netCashFlowKopecks, 2200000);

    // XLSX export check
    const xlsxRes = await reqJson(baseUrl, 'GET', '/api/export/database.xlsx', undefined, adminClient);
    assert.equal(xlsxRes.status, 200);
    assert.ok(xlsxRes.rawBuffer && xlsxRes.rawBuffer.length > 500);

    const wb = XLSX.read(xlsxRes.rawBuffer, { type: 'buffer' });
    assert.ok(wb.SheetNames.includes('Заказы'));
    assert.ok(wb.SheetNames.includes('Сотрудники'));
    const staffJson = JSON.stringify(XLSX.utils.sheet_to_json(wb.Sheets['Сотрудники']));
    assert.equal(staffJson.includes('scrypt$'), false);
    assert.equal(staffJson.includes('password_hash'), false);
  });
});
