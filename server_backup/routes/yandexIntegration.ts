import express from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { requireAdmin, type AuthedRequest } from '../middleware.ts';
import { writeAuditLog } from '../security.ts';
import type { createYandexOAuth } from '../services/yandexOAuth.ts';

export function createYandexIntegrationRouter(db:DatabaseSync,oauth:ReturnType<typeof createYandexOAuth>) {
  const router=express.Router();router.use(requireAdmin);
  router.get('/status',(_req,res)=>res.json(oauth.status()));
  router.post('/start',(req:AuthedRequest,res)=>{
    try {res.json({url:oauth.start(req.sessionId!,req.authUser!.id)});}
    catch(error) {res.status(400).json({error:error instanceof Error?error.message:'Ошибка настройки подключения.'});}
  });
  router.get('/callback',(req:AuthedRequest,res)=>{
    const state=typeof req.query.state==='string'?req.query.state:'',code=typeof req.query.code==='string'?req.query.code:'';
    void oauth.callback(state,code,req.sessionId!,req.authUser!.id).then(()=>{
      writeAuditLog(db,req.authUser!.id,'integration','yandex','yandex_connected',{});
      res.redirect(303,'/?yandex_connection=connected');
    }).catch(()=>res.redirect(303,'/?yandex_connection=failed'));
  });
  router.post('/disconnect',(req:AuthedRequest,res)=>{
    oauth.disconnect();writeAuditLog(db,req.authUser!.id,'integration','yandex','yandex_disconnected',{});
    res.json({ok:true});
  });
  return router;
}
