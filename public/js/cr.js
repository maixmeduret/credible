/*! Credible — privacy-first, cookieless analytics. AGPL-3.0 */
(function(window,document){'use strict';var location=window.location;var navigator=window.navigator||{};var history=window.history;function attr(el,name){try{return el&&el.getAttribute?el.getAttribute(name):null;}catch(e){return null;}}
function hasAttr(el,name){try{if(el&&el.hasAttribute)return el.hasAttribute(name);}catch(e){}
return attr(el,name)!=null;}
function splitList(value){var parts=String(value==null?'':value).split(',');var out=[];for(var i=0;i<parts.length;i++){var item=parts[i].replace(/^\s+|\s+$/g,'');if(item)out.push(item);}
return out;}
function findScript(){var el=document.currentScript;if(el)return el;var scripts=document.getElementsByTagName?document.getElementsByTagName('script'):[];for(var i=scripts.length-1;i>=0;i--){if(attr(scripts[i],'data-domain'))return scripts[i];}
return null;}
var script=findScript();if(!script)return;function flag(name){if(!hasAttr(script,name))return false;var value=attr(script,name);return value==null||value===''||value==='true'||value==='1';}
var DOMAINS=splitList(attr(script,'data-domain'));var HASH_MODE=flag('data-hash');var RESPECT_DNT=flag('data-respect-dnt');var TRACK_LOCAL=flag('data-track-localhost');var DEBUG=hasAttr(script,'data-debug')&&attr(script,'data-debug')!=='false';var EXCLUDED=buildExclusions(attr(script,'data-exclude'));var ENDPOINT=attr(script,'data-api')||apiEndpoint(script.src);function apiEndpoint(src){var origin=(location.protocol||'https:')+'//'+(location.host||location.hostname||'');var match=/^(https?:)?\/\/([^\/?#]+)/i.exec(src||'');if(match)origin=(match[1]||location.protocol||'https:')+'//'+match[2];return origin+'/api/event';}
function buildExclusions(value){var patterns=splitList(value);var out=[];for(var i=0;i<patterns.length;i++){var pattern=patterns[i];if(pattern.charAt(0)!=='/')pattern='/'+pattern;var source='';for(var j=0;j<pattern.length;j++){var c=pattern.charAt(j);if(c==='*'){if(pattern.charAt(j+1)==='*'){source+='.*';j++;}else{source+='[^/]*';}}else if('.+?^${}()|[]\\/'.indexOf(c)>-1){source+='\\'+c;}else{source+=c;}}
try{out.push(new RegExp('^'+source+'$'));}catch(e){}}
return out;}
var LOCAL_HOST=/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$|\.localhost$/i;var LOCAL=LOCAL_HOST.test(String(location.hostname||''));function dntEnabled(){return(navigator.doNotTrack==='1'||navigator.doNotTrack==='yes'||window.doNotTrack==='1'||navigator.msDoNotTrack==='1');}
function ignoreParam(){return/(^|[?&])credible_ignore=true(&|$)/i.test(String(location.search||''));}
function ignoreStored(){try{return window.localStorage&&window.localStorage.getItem('credible_ignore')==='true';}catch(e){return false;}}
function pathExcluded(){if(!EXCLUDED.length)return false;var path=currentPath();var bare=path.length>1?path.replace(/\/+$/,''):path;for(var i=0;i<EXCLUDED.length;i++){if(EXCLUDED[i].test(path)||EXCLUDED[i].test(bare))return true;}
return false;}
function ignoredReason(){if(!DOMAINS.length)return'the script tag has no data-domain attribute';if(location.protocol==='file:')return'the page is served from the filesystem';if(LOCAL&&!TRACK_LOCAL)return'localhost traffic is never counted (add data-track-localhost to test)';if(RESPECT_DNT&&dntEnabled())return'the browser sends Do Not Track';if(ignoreParam())return'the URL carries credible_ignore=true';if(ignoreStored())return'localStorage credible_ignore is set to "true"';if(pathExcluded())return'this path is listed in data-exclude';return null;}
function warn(message){if(!DEBUG&&!LOCAL)return;try{if(window.console&&window.console.warn)window.console.warn('[Credible] '+message);}catch(e){}}
function currentPath(){var path=String(location.pathname||'/');if(HASH_MODE&&location.hash)path+=location.hash;return path;}
function currentUrl(){var url=(location.protocol||'https:')+'//'+(location.hostname||'')+(location.port?':'+location.port:'')+(location.pathname||'/')+(location.search||'');if(HASH_MODE&&location.hash)url+=location.hash;return url;}
function parseUrl(href){var match=/^(?:([a-z][a-z0-9+.-]*:)?\/\/([^\/?#]*))?([^?#]*)/i.exec(String(href||''));return{protocol:(match&&match[1])||'',host:(match&&match[2])||'',path:(match&&match[3])||''};}
function viewportWidth(){return(window.innerWidth||(document.documentElement&&document.documentElement.clientWidth)||(document.body&&document.body.clientWidth)||0);}
function post(body,callback){if(navigator.sendBeacon){var queued=false;try{queued=navigator.sendBeacon(ENDPOINT,body);}catch(e){queued=false;}
if(queued){if(callback)callback({status:202});return;}}
try{var xhr=new window.XMLHttpRequest();xhr.open('POST',ENDPOINT,true);xhr.setRequestHeader('Content-Type','text/plain');xhr.onreadystatechange=function(){if(xhr.readyState===4&&callback)callback({status:xhr.status});};xhr.send(body);}catch(e){warn('could not send the event: '+e);if(callback)callback({status:0,error:true});}}
function cleanProps(props){if(!props||typeof props!=='object')return null;var out={};var kept=false;for(var key in props){if(!Object.prototype.hasOwnProperty.call(props,key))continue;var value=props[key];var type=typeof value;if(value===null||value===undefined)continue;if(type!=='string'&&type!=='number'&&type!=='boolean')continue;if(type==='number'&&!isFinite(value))continue;out[key]=value;kept=true;}
return kept?out:null;}
function cleanRevenue(revenue){if(!revenue||typeof revenue!=='object')return null;var amount=typeof revenue.amount==='string'?parseFloat(revenue.amount):revenue.amount;if(typeof amount!=='number'||!isFinite(amount))return null;var currency=revenue.currency?String(revenue.currency).toUpperCase():null;return currency?{amount:amount,currency:currency}:{amount:amount};}
function send(name,options){options=options||{};var reason=ignoredReason();if(reason){warn('"'+name+'" was not sent because '+reason+'.');if(options.callback)options.callback({status:0,ignored:true});return;}
var url=options.url||trackedUrl||currentUrl();var referrer=options.referrer!==undefined?options.referrer||null:document.referrer||null;var props=cleanProps(options.props);var revenue=cleanRevenue(options.revenue);var width=viewportWidth();var pending=DOMAINS.length;var settled=false;function done(result){pending--;if(pending>0||settled)return;settled=true;if(options.callback)options.callback(result);}
for(var i=0;i<DOMAINS.length;i++){var payload={n:name,d:DOMAINS[i],u:url,r:referrer,w:width,h:HASH_MODE?1:0};if(props)payload.p=props;if(revenue)payload.v=revenue;if(options.engagement)payload.e=options.engagement;post(JSON.stringify(payload),done);}}
var trackedUrl=null;var engagedMs=0;var engagedSince=null;var maxScroll=0;function now(){return Date.now?Date.now():new Date().getTime();}
function isVisible(){if(document.visibilityState)return document.visibilityState==='visible';return document.hidden!==true;}
function scrollDepth(){var docEl=document.documentElement||{};var body=document.body||{};var height=Math.max(body.scrollHeight||0,body.offsetHeight||0,docEl.clientHeight||0,docEl.scrollHeight||0,docEl.offsetHeight||0);var viewport=window.innerHeight||docEl.clientHeight||0;var top=window.pageYOffset;if(typeof top!=='number')top=docEl.scrollTop||body.scrollTop||0;if(!height||height<=viewport)return 100;var depth=Math.round(((top+viewport)/height)*100);return Math.max(0,Math.min(100,depth));}
function startEngagement(){if(engagedSince===null&&isVisible())engagedSince=now();}
function stopEngagement(){if(engagedSince===null)return;engagedMs+=Math.max(0,now()-engagedSince);engagedSince=null;}
function sendEngagement(){if(!trackedUrl)return;stopEngagement();if(engagedMs<=0)return;var engaged=engagedMs;engagedMs=0;send('engagement',{url:trackedUrl,engagement:{t:engaged,s:maxScroll}});startEngagement();}
function updateScroll(){var depth=scrollDepth();if(depth>maxScroll)maxScroll=depth;}
function trackPageview(overrides){overrides=overrides||{};trackedUrl=overrides.url||currentUrl();engagedMs=0;engagedSince=null;maxScroll=scrollDepth();startEngagement();var options={url:trackedUrl,props:overrides.props,revenue:overrides.revenue};if(overrides.referrer!==undefined)options.referrer=overrides.referrer;if(overrides.callback)options.callback=overrides.callback;send('pageview',options);}
function onNavigate(){if(currentUrl()===trackedUrl)return;sendEngagement();trackPageview();}
function patchHistory(method){if(!history||typeof history[method]!=='function')return;var original=history[method];history[method]=function(){var result=original.apply(this,arguments);try{onNavigate();}catch(e){warn('navigation tracking failed: '+e);}
return result;};}
var DOWNLOAD_EXTENSIONS=/\.(pdf|csv|docx?|xlsx?|zip|rar|7z|mp3|mp4|wav|dmg|exe|pkg|gz|tgz|txt|key|pptx?|avi|mov|mkv|svg)$/i;var TAG_PREFIX='credible+';var PROP_PREFIX='data-credible-event-';function isDownload(path){return DOWNLOAD_EXTENSIONS.test(String(path||''));}
function classNames(el){var value=el.className;if(typeof value!=='string')value=(value&&value.baseVal)||'';return value?value.split(/\s+/):[];}
function taggedEvent(el){var name=attr(el,'data-credible-event-name');if(!name){var tokens=classNames(el);for(var i=0;i<tokens.length;i++){if(tokens[i].indexOf(TAG_PREFIX)===0){name=tokens[i].slice(TAG_PREFIX.length).replace(/\+/g,' ');break;}}}
if(!name)return null;var props={};var kept=false;var attributes=el.attributes||[];for(var j=0;j<attributes.length;j++){var item=attributes[j];var key=item&&item.name?String(item.name).toLowerCase():'';if(key.indexOf(PROP_PREFIX)!==0)continue;key=key.slice(PROP_PREFIX.length);if(!key||key==='name')continue;props[key]=item.value;kept=true;}
return{name:name,props:kept?props:null};}
function closest(target){var node=target;var found={link:null,tagged:null};var depth=0;while(node&&depth++<40){if(!found.tagged&&(attr(node,'data-credible-event-name')||hasTagClass(node))){found.tagged=node;}
if(!found.link&&node.tagName&&String(node.tagName).toLowerCase()==='a'&&node.href){found.link=node;}
node=node.parentNode;}
return found;}
function hasTagClass(el){var tokens=classNames(el||{});for(var i=0;i<tokens.length;i++){if(tokens[i].indexOf(TAG_PREFIX)===0)return true;}
return false;}
function onClick(event){if(!event)return;var middle=event.button===1;if(event.button!==undefined&&event.button!==0&&!middle)return;if(event.type==='auxclick'&&!middle)return;var found=closest(event.target||event.srcElement);var events=[];if(found.tagged){var tagged=taggedEvent(found.tagged);if(tagged)events.push(tagged);}
var link=found.link;var href=link?String(link.href):'';var parsed=link?parseUrl(href):null;if(link){if(parsed.host&&parsed.host!==location.host){events.push({name:'Outbound Link: Click',props:{url:href}});}
if(isDownload(parsed.path)){events.push({name:'File Download',props:{url:href}});}}
if(!events.length)return;var httpLink=!parsed||!parsed.protocol||/^https?:$/i.test(parsed.protocol);var unloads=!!link&&httpLink&&!middle&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey&&!hasAttr(link,'download')&&String(link.target||'').toLowerCase()!=='_blank'&&typeof event.preventDefault==='function';var followed=false;var follow=function(){if(followed)return;followed=true;try{location.href=href;}catch(e){}};var remaining=events.length;var afterSend=function(){if(--remaining<=0)follow();};if(unloads){event.preventDefault();if(window.setTimeout)window.setTimeout(follow,150);}
for(var i=0;i<events.length;i++){send(events[i].name,{props:events[i].props,callback:unloads?afterSend:null});}}
function onSubmit(){send('Form: Submission');}
function credible(name,options){try{options=options||{};if(!name||typeof name!=='string'){warn('an event name is required');return;}
if(name==='pageview'){trackPageview(options);return;}
send(name,{url:options.url,referrer:options.referrer,props:options.props,revenue:options.revenue,callback:options.callback});}catch(e){warn('credible("'+name+'") failed: '+e);}}
function trackEvent(name,options){credible(name,options);}
function on(target,type,handler,options){try{if(!target||!target.addEventListener)return;target.addEventListener(type,function(event){try{handler(event);}catch(e){warn('the '+type+' handler failed: '+e);}},options);}catch(e){}}
function onVisibilityChange(){if(isVisible())startEngagement();else sendEngagement();}
if(window.credible&&window.credible.l)return;var queued=window.credible&&window.credible.q;credible.trackPageview=trackPageview;credible.trackEvent=trackEvent;credible.l=true;credible.q={push:function(args){credible.apply(null,args);}};window.credible=credible;try{patchHistory('pushState');patchHistory('replaceState');on(window,'popstate',onNavigate);if(HASH_MODE)on(window,'hashchange',onNavigate);on(document,'click',onClick,true);on(document,'auxclick',onClick,true);on(document,'submit',onSubmit,true);on(window,'scroll',updateScroll,{passive:true});on(document,'visibilitychange',onVisibilityChange);on(window,'pagehide',sendEngagement);trackPageview();if(queued&&queued.length){for(var q=0;q<queued.length;q++){credible.apply(null,queued[q]);}}}catch(e){warn('startup failed: '+e);}})(window,document);