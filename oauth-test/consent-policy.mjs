// Pure validation; neither user credentials nor server identity are trusted here.
export function authorizationIdFromURL(value) {
 try {
  const ids=new URL(value).searchParams.getAll('authorization_id');
  // Supabase issues an opaque 32-character ID, not the authorization row UUID.
  return ids.length===1 && /^[A-Za-z0-9]{32}$/.test(ids[0]) ? ids[0] : null;
 } catch { return null; }
}
export function connectionConfigAllowed(config) {
 if (!config || typeof config !== 'object' || Array.isArray(config)
  || Object.keys(config).sort().join(',') !== 'callback,clientId,publishableKey'
  || typeof config.publishableKey !== 'string'
  || !/^sb_publishable_[A-Za-z0-9_-]{20,80}$/.test(config.publishableKey)
  || typeof config.clientId !== 'string'
  || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(config.clientId)
  || typeof config.callback !== 'string') return false;
 try {
  const u = new URL(config.callback);
  return u.origin === 'https://chatgpt.com'
   && /^\/connector\/oauth\/[A-Za-z0-9_-]{8,100}$/.test(u.pathname)
   && !u.username && !u.password && !u.search && !u.hash;
 } catch { return false; }
}
export const ACCEPTED_SCOPES=Object.freeze(['openid','email','offline_access']);
export function scopeAllowed(scope) {
 return typeof scope==='string' && scope.length<=64
  && scope.split(' ').sort().join(' ')==='email offline_access openid';
}
export function consentAllowed(details, config) {
 return typeof config.clientId==='string' && config.clientId.length>0
  && typeof config.callback==='string' && config.callback.startsWith('https://chatgpt.com/')
  && details?.client?.id===config.clientId && details.redirect_uri===config.callback
  && scopeAllowed(details.scope);
}
export function callbackAllowed(value, exact) {
 try {
  const u=new URL(value), e=new URL(exact);
  return u.origin==='https://chatgpt.com' && e.origin===u.origin && e.pathname===u.pathname
   && !u.username && !u.password && !u.hash && !e.search && !e.hash;
 } catch { return false; }
}

// Recovery is a separate fixed-origin route. No implicit tokens, OAuth request
// IDs, redirect destinations or unknown/duplicate parameters are accepted.
export const RECOVERY_URL='https://alexio00.github.io/HEALTH/oauth-test/consent.html?mode=recovery';
export const RECOVERY_KEY='health-test-password-recovery:v1';
export const RECOVERY_TTL_MS=15*60*1000;
export function recoveryFromURL(value) {
 try {
  const u=new URL(value),expected=new URL(RECOVERY_URL);
  if(u.origin!==expected.origin || u.pathname!==expected.pathname
   || u.username || u.password || u.hash
   || u.searchParams.getAll('mode').length!==1 || u.searchParams.get('mode')!=='recovery'
   || [...u.searchParams.keys()].some(k=>k!=='mode' && k!=='code')
   || u.searchParams.getAll('code').length>1) return null;
  const code=u.searchParams.get('code');
  if(code===null)return {kind:'start'};
  return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(code)
   ? {kind:'callback',code} : null;
 } catch {return null;}
}
export function recoveryRecordAllowed(value,now) {
 return value!==null && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',')==='startedAt,verifier'
  && typeof value.verifier==='string' && /^[a-f0-9]{64}$/.test(value.verifier)
  && Number.isSafeInteger(value.startedAt) && Number.isSafeInteger(now)
  && value.startedAt<=now && now-value.startedAt<RECOVERY_TTL_MS;
}
export function recoverySessionAllowed(value) {
 return value!==null && typeof value==='object' && value.token_type==='bearer'
  && typeof value.access_token==='string' && value.access_token.length<=8192
  && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.access_token)
  && Number.isSafeInteger(value.expires_in) && value.expires_in>0 && value.expires_in<=86400
  && typeof value.user?.id==='string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.user.id)
  && value.user.is_anonymous===false;
}


