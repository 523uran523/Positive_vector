import http from 'node:http';
import net from 'node:net';
import type express from 'express';

/** Exercise Express, parsers, auth, CSRF and streaming without a listening socket. */
export function inject(app:express.Express, method:string,url:string,body?:string|Buffer,headers:Record<string,string>={}):Promise<Response> {
  return new Promise((resolve,reject)=>{
    const socket=new net.Socket();
    const req=new http.IncomingMessage(socket);
    req.method=method;req.url=url;
    req.headers=Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),v]));
    if(body!==undefined) req.headers['content-length']=String(Buffer.byteLength(body));
    const res=new http.ServerResponse(req);
    const chunks:Buffer[]=[];
    res.write=((chunk:any,encoding?:any,callback?:any)=>{chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding as BufferEncoding:undefined));if(typeof callback==='function')callback();return true;}) as typeof res.write;
    res.end=((chunk?:any,encoding?:any)=>{
      if(chunk) chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding as BufferEncoding:undefined));
      const h=new Headers();
      for(const [k,v] of Object.entries(res.getHeaders())) for(const value of Array.isArray(v)?v:[v]) if(value!==undefined) h.append(k,String(value));
      const bytes=Buffer.concat(chunks);
      resolve(new Response([204,304].includes(res.statusCode)?null:bytes,{status:res.statusCode,headers:h}));
      queueMicrotask(()=>res.emit('finish'));
      return res;
    }) as typeof res.end;
    req.on('error',reject);res.on('error',reject);
    app(req,res);
    if(body!==undefined)req.push(body);
    req.complete=true;
    req.push(null);
  });
}
