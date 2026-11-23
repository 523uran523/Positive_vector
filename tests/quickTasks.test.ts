import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../server/app.ts';
import { openDatabase, runMigrations } from '../server/db.ts';
import { inject } from './httpHarness.ts';

test('quick tasks: visibility, reassignment of deadline and completion by one assignee', async () => {
  const db=openDatabase(':memory:'); runMigrations(db); const app=createApp(db);
  let cookie='', csrf='';
  async function call(method:string,url:string,body?:unknown) {
    const res=await inject(app,method,url,body===undefined?undefined:JSON.stringify(body),{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':csrf});
    return {res,status:res.status,data:await res.json()};
  }
  try {
    const setup=await call('POST','/api/auth/setup',{login:'admin',password:'long-password-123',fullName:'Admin'});
    const adminCookie=setup.res.headers.get('set-cookie')!.split(';')[0], adminCsrf=setup.data.csrfToken;
    cookie=adminCookie;csrf=adminCsrf;
    const a=await call('POST','/api/users',{login:'worker1',fullName:'Worker 1',password:'long-password-123'});
    const b=await call('POST','/api/users',{login:'worker2',fullName:'Worker 2',password:'long-password-123'});
    const c=await call('POST','/api/users',{login:'outsider',fullName:'Outsider',password:'long-password-123'});
    const created=await call('POST','/api/quick-tasks',{title:'Подготовить материал',description:'Подробности',dueDate:'2026-11-20',assigneeIds:[a.data.user.id,b.data.user.id]});
    assert.equal(created.status,201); const id=created.data.task.id;
    assert.equal(created.data.task.assignees.length,2); assert.ok(created.data._versions[`/api/quick-tasks/${id}`]);
    assert.equal((await call('POST',`/api/quick-tasks/${id}/complete`,{comment:'Не исполнитель'})).status,403);
    const outsiderLogin=await call('POST','/api/auth/login',{login:'outsider',password:'long-password-123'});
    cookie=outsiderLogin.res.headers.get('set-cookie')!.split(';')[0];csrf=outsiderLogin.data.csrfToken;
    assert.deepEqual((await call('GET','/api/quick-tasks')).data.tasks,[]);
    assert.equal((await call('GET',`/api/quick-tasks/${id}`)).status,404);
    assert.equal((await call('PATCH',`/api/quick-tasks/${id}`,{dueDate:'2026-11-21'})).status,404);
    const own=await call('POST','/api/quick-tasks',{title:'Своя задача',dueDate:'2026-11-21',assigneeIds:[c.data.user.id]});assert.equal(own.status,201);
    const login=await call('POST','/api/auth/login',{login:'worker1',password:'long-password-123'});
    cookie=login.res.headers.get('set-cookie')!.split(';')[0];csrf=login.data.csrfToken;
    assert.equal((await call('GET','/api/quick-tasks')).data.tasks.length,1);
    assert.equal((await call('PATCH',`/api/quick-tasks/${id}`,{dueDate:'2026-02-30'})).status,400);
    const moved=await call('PATCH',`/api/quick-tasks/${id}`,{dueDate:'2026-11-22'});assert.equal(moved.status,200);assert.equal(moved.data.task.due_date,'2026-11-22');
    assert.equal((await call('POST',`/api/quick-tasks/${id}/complete`,{comment:'  '})).status,400);
    const completed=await call('POST',`/api/quick-tasks/${id}/complete`,{comment:'Подготовил'});assert.equal(completed.status,200);assert.equal(completed.data.task.status,'completed');assert.equal(completed.data.task.completion_comment,'Подготовил');
    assert.equal((await call('POST',`/api/quick-tasks/${id}/complete`,{comment:'Повтор'})).status,409);
    assert.equal((await call('PATCH',`/api/quick-tasks/${id}`,{dueDate:'2026-11-23'})).status,200);
    const reopened=await call('POST',`/api/quick-tasks/${id}/reopen`,{});assert.equal(reopened.data.task.status,'open');
    assert.equal((await call('POST',`/api/quick-tasks/${id}/cancel`,{})).data.task.status,'cancelled');
    assert.equal((await call('POST',`/api/quick-tasks/${id}/complete`,{comment:'Нельзя'})).status,409);
    assert.equal((await call('POST',`/api/quick-tasks/${id}/reopen`,{})).data.task.status,'open');
    const reassigned=await call('POST',`/api/quick-tasks/${id}/assignees`,{assigneeIds:[b.data.user.id]});
    assert.equal(reassigned.data.stillVisible,false);
    assert.equal((await call('GET',`/api/quick-tasks/${id}`)).status,404);
    const event=db.prepare("SELECT details_json FROM quick_task_events WHERE task_id=? AND event_type='reopen' ORDER BY rowid LIMIT 1").get(id) as {details_json:string};
    assert.equal(JSON.parse(event.details_json).comment,'Подготовил');
    cookie=adminCookie;csrf=adminCsrf;
    assert.equal((await call('GET','/api/quick-tasks')).data.tasks.length,2);

    // Timeless quick task (dueDate: '') is allowed, listed in /api/shifts/today-options, and excluded from uncoveredCount
    const timeless=await call('POST','/api/quick-tasks',{title:'Бессрочная задача',dueDate:'',assigneeIds:[a.data.user.id]});
    assert.equal(timeless.status,201);
    assert.equal(timeless.data.task.due_date,'');

    const w1Login=await call('POST','/api/auth/login',{login:'worker1',password:'long-password-123'});
    cookie=w1Login.res.headers.get('set-cookie')!.split(';')[0];csrf=w1Login.data.csrfToken;
    const todayOpts=await call('GET','/api/shifts/today-options?tzOffsetMinutes=0');
    assert.equal(todayOpts.status,200);
    assert.ok(todayOpts.data.quickTasks.some((qt:any)=>qt.quickTaskId===timeless.data.task.id));
    assert.equal(todayOpts.data.uncoveredCount,0);

    cookie=adminCookie;csrf=adminCsrf;
    const reports=await call('GET','/api/reports');
    assert.equal(reports.status,200);
    assert.equal(reports.data.quickTasksSummary.total,3);
    assert.equal(reports.data.quickTasksSummary.open,3);
    assert.ok(Array.isArray(reports.data.quickTaskReports));
  } finally {db.close();}
});
