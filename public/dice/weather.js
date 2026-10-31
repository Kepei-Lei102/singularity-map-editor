(function(root){
  'use strict';
  const PLACES=[
    ['京都 · 日本',35,135.8,'Asia/Tokyo'],['里斯本 · 葡萄牙',38.7,-9.1,'Europe/Lisbon'],['雷克雅未克 · 冰岛',64.1,-21.9,'Atlantic/Reykjavik'],['开普敦 · 南非',-33.9,18.4,'Africa/Johannesburg'],['皇后镇 · 新西兰',-45,168.7,'Pacific/Auckland'],['温哥华 · 加拿大',49.3,-123.1,'America/Vancouver'],['瓦尔帕莱索 · 智利',-33,-71.6,'America/Santiago'],['卑尔根 · 挪威',60.4,5.3,'Europe/Oslo'],['清迈 · 泰国',18.8,99,'Asia/Bangkok'],['霍巴特 · 澳大利亚',-42.9,147.3,'Australia/Hobart'],['马德拉 · 葡萄牙',32.7,-16.9,'Atlantic/Madeira'],['乌斯怀亚 · 阿根廷',-54.8,-68.3,'America/Argentina/Ushuaia']
  ].map(([name,lat,lon,timezone])=>({name,lat,lon,timezone}));
  const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
  function randomPlace(random=Math.random,except){const places=PLACES.filter(p=>p.name!==except);return {...places[Math.min(places.length-1,Math.floor(random()*places.length))]};}
  function condition(code){return code===0?'晴朗':code<=2?'多云':code===3?'阴天':code<=48?'雾':code>=71&&code<=77||code===85||code===86?'降雪':code>=95?'雷雨':'降雨';}
  function localHour(now,timezone){const p=new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);return Number(p.find(v=>v.type==='hour').value)+Number(p.find(v=>v.type==='minute').value)/60;}
  function simulated(place,now=Date.now()){
    const hour=localHour(now,place.timezone||'UTC'),day=hour>=6&&hour<18;
    return{time:now/1000,isDay:day,cloud:45,precipitation:0,code:2,temperature:null,timezone:place.timezone||'UTC',sunrise:null,sunset:null,phase:clamp((hour-6)/12)};
  }
  function parse(data,now=Date.now()){
    const c=data?.current,d=data?.daily;
    if(!c||!Number.isFinite(c.time)||Math.abs(c.time*1000-now)>6*3600000||![0,1].includes(c.is_day)||!Number.isFinite(c.cloud_cover)||c.cloud_cover<0||c.cloud_cover>100||!Number.isFinite(c.precipitation)||c.precipitation<0||!Number.isFinite(c.weather_code)||!Number.isFinite(c.temperature_2m))throw new Error('天气数据不完整');
    const timezone=data.timezone||'UTC';localHour(now,timezone);
    const sunrise=d?.sunrise?.[0],sunset=d?.sunset?.[0];
    return{time:c.time,isDay:!!c.is_day,cloud:c.cloud_cover,precipitation:c.precipitation,code:c.weather_code,temperature:c.temperature_2m,timezone,sunrise:Number.isFinite(sunrise)?sunrise:null,sunset:Number.isFinite(sunset)?sunset:null,phase:.5};
  }
  function light(weather,now=Date.now()){
    const day=weather.isDay,cloud=clamp(weather.cloud/100),rain=clamp(weather.precipitation/3);
    const phase=weather.sunrise&&weather.sunset>weather.sunrise?clamp((now/1000-weather.sunrise)/(weather.sunset-weather.sunrise)):weather.phase;
    const elevation=day?Math.max(.15,Math.sin(Math.PI*phase)):0;
    return{day,cloud,rain,snow:condition(weather.code)==='降雪',phase,
      direct:day?(1-cloud*.93)*(1-rain*.45)*(1.2+elevation*1.4):.09,
      ambient:day?2.65+cloud*.4:.8,lamp:day?.65:2.1,
      warmth:day?1-elevation:0,shadowRadius:day?1.5+cloud*4:4,
      sky:day?(cloud>.75?'#9cabba':phase<.17||phase>.83?'#d6ac8a':'#92bfd2'):'#17283f'};
  }
  function url(place){const p=new URLSearchParams({latitude:place.lat.toFixed(1),longitude:place.lon.toFixed(1),current:'temperature_2m,is_day,precipitation,weather_code,cloud_cover',daily:'sunrise,sunset',timezone:'auto',timeformat:'unixtime',forecast_days:'1'});return 'https://api.open-meteo.com/v1/forecast?'+p;}
  class Weather{
    constructor({fetch:fetcher=root.fetch?.bind(root),geolocation=root.navigator?.geolocation,onChange=()=>{},now=Date.now,random=Math.random,timeout=9000}={}){
      Object.assign(this,{fetcher,geolocation,onChange,now,random,timeout});this.sequence=0;this.cache=new Map();this.state=null;this.controller=null;
    }
    emit(state){this.state=state;this.onChange(state);}
    async load(place,mode='world',notice=''){
      const sequence=++this.sequence;this.controller?.abort();const controller=new AbortController();this.controller=controller;this.place=place;this.mode=mode;
      this.emit({status:'loading',place,mode,notice});const timer=setTimeout(()=>controller.abort(),this.timeout);
      try{
        const response=await this.fetcher(url(place),{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});if(!response.ok)throw new Error('天气服务暂不可用');
        const weather=parse(await response.json(),this.now());if(sequence!==this.sequence)return;
        this.cache.set(`${place.lat},${place.lon}`,weather);
        this.emit({status:this.now()-weather.time*1000>90*60000?'stale':'live',place,mode,notice,weather});
      }catch(error){
        if(sequence!==this.sequence)return;const cached=this.cache.get(`${place.lat},${place.lon}`);
        const usable=cached&&this.now()-cached.time*1000<2*3600000;
        this.emit({status:usable?'stale':'simulated',place,mode,notice,weather:usable?cached:simulated(place,this.now())});
      }finally{clearTimeout(timer);}
    }
    world(notice=''){return this.load(randomPlace(this.random,this.place?.name),'world',notice);}
    async local(){
      const sequence=++this.sequence;this.controller?.abort();this.emit({status:'locating',place:this.place,mode:'local',notice:'正在请求浏览器定位…'});
      try{
        if(!this.geolocation)throw new Error('定位不可用');
        const position=await new Promise((resolve,reject)=>this.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:false,timeout:8000,maximumAge:30*60000}));
        if(sequence!==this.sequence)return;const c=position.coords;
        if(!Number.isFinite(c.latitude)||!Number.isFinite(c.longitude))throw new Error('定位不可用');
        return this.load({name:'你所在的附近',lat:Math.round(c.latitude*10)/10,lon:Math.round(c.longitude*10)/10,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone},'local');
      }catch(error){if(sequence!==this.sequence)return;return this.world('未使用定位，已为你换到世界一隅。');}
    }
    refresh(){if(this.place&&this.state?.status!=='locating')return this.load(this.place,this.mode);}
    dispose(){++this.sequence;this.controller?.abort();}
  }
  root.DiceWeather={PLACES,randomPlace,condition,simulated,parse,light,url,Weather};if(typeof module!=='undefined')module.exports=root.DiceWeather;
})(typeof window==='undefined'?globalThis:window);
