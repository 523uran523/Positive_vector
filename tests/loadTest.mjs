// Read-only authenticated load test. Credentials are supplied through the environment.
const base=process.env.PV_BASE_URL;
if(!base || !process.env.PV_LOGIN || !process.env.PV_PASSWORD) throw new Error('Set PV_BASE_URL, PV_LOGIN and PV_PASSWORD');
if(!base.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base)) throw new Error('Use HTTPS or localhost');
const workers=Number(process.env.PV_WORKERS||15),seconds=Number(process.env.PV_SECONDS||30);
if(!Number.isInteger(workers)||workers<1||workers>30||!Number.isInteger(seconds)||seconds<1||seconds>300)throw new Error('Workers: 1–30; seconds: 1–300');
const response=await fetch(new URL('/api/auth/login',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:process.env.PV_LOGIN,password:process.env.PV_PASSWORD}),signal:AbortSignal.timeout(15000)});
if(!response.ok)throw new Error('Load test login failed');
const cookie=response.headers.get('set-cookie')?.split(';')[0];
const auth=await response.json();
if(!cookie)throw new Error('No session cookie');
const until=Date.now()+seconds*1000;
let failures=0;const timings=[];
await Promise.all(Array.from({length:workers},async()=>{
  let n=0;
  while(Date.now()<until){
    const started=performance.now();
    try{const res=await fetch(new URL(['/api/orders','/api/warehouse','/api/notifications'][n++%3],base),{headers:{Cookie:cookie},signal:AbortSignal.timeout(15000)});if(!res.ok)failures++;await res.arrayBuffer();}
    catch{failures++;}finally{timings.push(performance.now()-started);}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
}));
timings.sort((a,b)=>a-b);
console.log(JSON.stringify({workers,seconds,requests:timings.length,failures,p50ms:Math.round(timings[Math.floor(timings.length*.5)]||0),p95ms:Math.round(timings[Math.floor(timings.length*.95)]||0),maxms:Math.round(timings.at(-1)||0)},null,2));
await fetch(new URL('/api/auth/logout',base),{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':auth.csrfToken},signal:AbortSignal.timeout(15000)});
if(failures)process.exitCode=1;
