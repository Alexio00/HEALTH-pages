import { consentAllowed,callbackAllowed,connectionConfigAllowed,authorizationIdFromURL,recoveryFromURL,recoveryRecordAllowed,recoverySessionAllowed,RECOVERY_URL,RECOVERY_KEY } from './consent-policy.mjs';
// Runtime parameters live in private TEST configuration, never in public GitHub.
let CONFIG=null;
const CONFIG_URL='https://yjmcesdayfmfissghzgm.supabase.co/functions/v1/health-chat-mcp-test-v1/connection-info';
const ROOT='https://yjmcesdayfmfissghzgm.supabase.co/auth/v1';
const $=id=>document.getElementById(id);
const status=text=>{$('status').textContent=text;};
const authId=authorizationIdFromURL(location.href);
let token=null;
let reviewed=null;
const recoveryRequested=new URL(location.href).searchParams.has('mode');
const recoveryRoute=recoveryFromURL(location.href);
// Remove the one-time code (or any unexpected recovery parameters) before
// configuration/network requests. The document already forbids referrers.
if(recoveryRequested)history.replaceState(null,'',RECOVERY_URL);
let recoveryToken=null,recoverySubject=null,recoveryExpiresAt=0,recoveryBusy=false;
async function request(path,body,session,method=body===undefined?'GET':'POST') {
 const response=await fetch(ROOT+path,{method,
  headers:{apikey:CONFIG.publishableKey,...(session?{authorization:'Bearer '+session}:{}),
   ...(body===undefined?{}:{'content-type':'application/json'})},
  ...(body===undefined?{}:{body:JSON.stringify(body)}),cache:'no-store',credentials:'omit',redirect:'error',
  referrerPolicy:'no-referrer',signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('AUTH_REQUEST_REJECTED');
 if(response.status===204)return null;
 return response.json();
}
function clearRecoverySession() {
 recoveryToken=null;recoverySubject=null;recoveryExpiresAt=0;
 $('recover-password').elements.password.value='';
 $('recover-password').elements.confirmation.value='';
 $('recover-password').querySelector('button').disabled=true;
}
function readRecoveryRecord() {
 const raw=localStorage.getItem(RECOVERY_KEY);
 if(raw===null)return null;
 let record;try{if(raw.length>256)throw Error('RECORD_SIZE');record=JSON.parse(raw);}catch{record=null;}
 if(!recoveryRecordAllowed(record,Date.now())){localStorage.removeItem(RECOVERY_KEY);return null;}
 return record;
}
function removeOwnRecord(record) {
 const current=readRecoveryRecord();
 if(current?.verifier===record.verifier)localStorage.removeItem(RECOVERY_KEY);
}
async function startRecoveryCallback() {
 let record;
 try{
  record=readRecoveryRecord();
  if(!record)throw Error('RECOVERY_REQUEST_MISSING');
  // Consume the browser verifier once. The Auth server separately enforces
  // code/S256 binding and destroys the successful flow state transactionally.
  localStorage.removeItem(RECOVERY_KEY);
  const result=await request('/token?grant_type=pkce',{
   auth_code:recoveryRoute.code,code_verifier:record.verifier});
  record=null;
  if(!recoverySessionAllowed(result))throw Error('RECOVERY_SESSION_REJECTED');
  recoveryToken=result.access_token;recoverySubject=result.user.id;
  recoveryExpiresAt=Date.now()+Math.min(600,result.expires_in)*1000;
  $('recover-email').hidden=true;$('recover-password').hidden=false;
  $('recover-password').querySelector('button').disabled=false;
  status('Ссылка подтверждена. Задай новый пароль из 12–128 символов.');
 }catch{record=null;clearRecoverySession();
  status('Ссылка недействительна, уже использована, истекла или открыта в другом браузере. Запроси новое письмо.');
  $('recover-email').querySelector('button').disabled=false;
 }
}
$('recover-email').addEventListener('submit',async event=>{
 event.preventDefault();if(!CONFIG || !recoveryRoute || recoveryBusy)return;
 const form=event.currentTarget;let record=null;
 recoveryBusy=true;form.querySelector('button').disabled=true;
 try{
  const pending=readRecoveryRecord();
  if(pending)throw Error('RECOVERY_PENDING');
  const email=form.elements.email.value.trim();
  if(!email || email.length>254)throw Error('EMAIL_INVALID');
  const bytes=crypto.getRandomValues(new Uint8Array(32));
  const verifier=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier));
  const challenge=btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  record={verifier,startedAt:Date.now()};
  localStorage.setItem(RECOVERY_KEY,JSON.stringify(record));
  if(localStorage.getItem(RECOVERY_KEY)!==JSON.stringify(record))throw Error('STORAGE_UNAVAILABLE');
  await request('/recover?redirect_to='+encodeURIComponent(RECOVERY_URL),{
   email,code_challenge:challenge,code_challenge_method:'s256'});
  status('Запрос принят. Если учётная запись существует, придёт письмо восстановления. Открой его ссылку в этом браузере в течение 15 минут.');
 }catch(error){
  if(record){try{removeOwnRecord(record);}catch{}}
  status(error?.message==='RECOVERY_PENDING'
   ? 'Письмо уже запрошено в этом браузере. Проверь входящие и спам; повторный запрос доступен через 15 минут.'
   : 'Запрос письма не подтверждён. Проверь email, доступность сервиса и возможность отправки писем.');
 }finally{record=null;form.elements.email.value='';recoveryBusy=false;form.querySelector('button').disabled=false;}
});
$('recover-password').addEventListener('submit',async event=>{
 event.preventDefault();if(!CONFIG || recoveryBusy)return;
 const form=event.currentTarget;
 if(!recoveryToken || Date.now()>=recoveryExpiresAt){clearRecoverySession();status('Время смены пароля истекло. Запроси новое письмо.');return;}
 if(form.elements.password.value.length<12 || form.elements.password.value.length>128
  || form.elements.password.value!==form.elements.confirmation.value){
  form.elements.password.value='';form.elements.confirmation.value='';
  status('Пароли должны совпадать и содержать 12–128 символов.');return;
 }
 recoveryBusy=true;form.querySelector('button').disabled=true;
 let updated=false;
 try{
  const user=await request('/user',{password:form.elements.password.value},recoveryToken,'PUT');
  form.elements.password.value='';form.elements.confirmation.value='';
  if(user?.id!==recoverySubject)throw Error('RECOVERY_USER_MISMATCH');
  updated=true;
  await request('/logout?scope=global',undefined,recoveryToken,'POST');
  status('Пароль изменён, сессии завершены. Вернись в ChatGPT и заново нажми «Подключить» у HEALTH-TEST Writer Probe.');
 }catch{status(updated
  ? 'Пароль изменён, но завершение сессий не подтверждено. Вернись в ChatGPT и проверь вход новым паролем.'
  : 'Результат смены пароля не подтверждён. Не повторяй автоматически: проверь вход или запроси новое письмо.');
 }finally{clearRecoverySession();recoveryBusy=false;}
});
async function loadReview() {
 const details=await request('/oauth/authorizations/'+encodeURIComponent(authId),undefined,token);
 if(!consentAllowed(details,CONFIG)){
  if(details?.client?.id===CONFIG.clientId && details.redirect_uri===CONFIG.callback)
   throw Error('OAUTH_SCOPE_NOT_ACCEPTED');
  throw Error('UNACCEPTED_CLIENT_CALLBACK_OR_SCOPE');
 }
 reviewed=details;
 $('details').textContent=JSON.stringify({client:details.client.name,client_id:details.client.id,
  callback:details.redirect_uri,scope:details.scope},null,2);
 $('review').hidden=false;$('login').hidden=true;$('approve').disabled=false;$('deny').disabled=false;
 status('Проверь приложение и адрес возврата. Токены остаются в памяти этой страницы.');
}
$('login').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.currentTarget;
 try{
  status('Проверяю вход…');
  const result=await request('/token?grant_type=password',{email:form.elements.email.value,password:form.elements.password.value});
  form.elements.password.value='';
  if(typeof result.access_token!=='string')throw Error('SESSION_MISSING');token=result.access_token;
  await loadReview();
 }catch(error){token=null;reviewed=null;form.elements.password.value='';
  status(error?.message==='OAUTH_SCOPE_NOT_ACCEPTED'
   ? 'Приложение запросило scope за пределами согласованного TEST-набора. Подключение остановлено.'
   : 'Вход или подключение отклонены. Проверь учётную запись и настройки OAuth.');}
});
for(const action of ['approve','deny'])$(action).addEventListener('click',async()=>{
 $('approve').disabled=true;$('deny').disabled=true;
 try{
  if(!token||!reviewed)throw Error('REVIEW_REQUIRED');
  // Re-read before consent; accepted client, exact callback and scope must still match.
  const current=await request('/oauth/authorizations/'+encodeURIComponent(authId),undefined,token);
  if(!consentAllowed(current,CONFIG))throw Error('REVIEW_CHANGED');
  const result=await request('/oauth/authorizations/'+encodeURIComponent(authId)+'/consent',{action},token);
  if(!callbackAllowed(result.redirect_url,CONFIG.callback))throw Error('CALLBACK_REJECTED');
  token=null;reviewed=null;location.assign(result.redirect_url);
 }catch{token=null;reviewed=null;status('Результат согласия не подтверждён. Не повторяй автоматически; начни новое подключение.');}
});
async function initialize() {
 if(recoveryRequested){
  $('login').hidden=true;$('forgot').hidden=true;$('recovery').hidden=false;
  document.title='HEALTH-TEST — восстановление пароля';
  if(!recoveryRoute){status('Некорректная ссылка восстановления. Открой страницу «Не помню пароль» и запроси новое письмо.');return;}
 }else if(!authId){
  status('Начни подключение из ChatGPT: отсутствует корректный запрос OAuth.');return;
 }
 try {
  const response=await fetch(CONFIG_URL,{method:'GET',cache:'no-store',credentials:'omit',
   redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('CONFIG_UNAVAILABLE');
  const text=await response.text();if(text.length>2048)throw Error('CONFIG_TOO_LARGE');
  const config=JSON.parse(text);if(!connectionConfigAllowed(config))throw Error('CONFIG_REJECTED');
  CONFIG=Object.freeze(config);
  if(recoveryRoute){
   if(recoveryRoute.kind==='callback')await startRecoveryCallback();
   else{$('recover-email').querySelector('button').disabled=false;status('Введи email существующей учётной записи HEALTH-TEST.');}
  }else{
   $('login').querySelector('button').disabled=false;
   status('Войди в существующую учётную запись HEALTH-TEST.');
  }
 }catch{CONFIG=null;status('Настройка подключения недоступна. Вход закрыт до её проверки.');}
}
initialize();
window.addEventListener('pagehide',()=>{token=null;reviewed=null;clearRecoverySession();$('login').elements.password.value='';});
window.addEventListener('pageshow',event=>{if(event.persisted && recoveryRequested){clearRecoverySession();status('Сессия восстановления завершена. Запроси новое письмо.');}});


