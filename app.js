const colors={city:'#39d5ff',county:'#9b4dff',state:'#ffcf32',private:'#ff9b2f'};
const SOURCE_TEXT='MN BCA official LPR registry — dps.mn.gov/divisions/bca/data-and-reports/agencies-use-lprs-lpr';
const GEO_CACHE_KEY='mn-lpr-geocode-cache-v5';
const GEO_DELAY_MS=1150;

/*
  EXACT MARKER RULE:
  The BCA-style location list gives street/intersection text, not verified latitude/longitude.
  Older versions used fallback coordinates, which caused wrong pins.

  This version DOES NOT show fallback pins as exact map markers.
  It shows only:
  1) manually verified coordinates in MANUAL_COORD_OVERRIDES, or
  2) coordinates returned by the browser map lookup and cached locally.

  Add verified corrections here:
  'record-id': [latitude, longitude]
*/
const MANUAL_COORD_OVERRIDES={
  // Example:
  // 'fari-002': [44.000000, -93.000000]
};

let active=null;
let markers=[];
let markerById={};
let map;
let geoQueue=[];
let geoQueued=new Set();
let geoBusy=false;
let geoCache=loadGeoCache();
let markerMode='verified'; // verified = no wrong fallback pins; approx = show fallback pins too

const total=LPR_LOCATIONS.length;
count.textContent=total;
listCount.textContent=total;
if(typeof listTotal!=='undefined') listTotal.textContent=total;

function loadGeoCache(){
  try{return JSON.parse(localStorage.getItem(GEO_CACHE_KEY)||'{}')}
  catch(e){return {}}
}

function saveGeoCache(){
  try{localStorage.setItem(GEO_CACHE_KEY,JSON.stringify(geoCache))}
  catch(e){}
}

function showTab(id){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');

  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('on'));
  if(id==='mapTab') mapNav?.classList.add('on');
  if(id==='listTab') listNav?.classList.add('on');
  if(id==='aboutTab') aboutNav?.classList.add('on');

  setTimeout(()=>{
    map&&map.invalidateSize();
    if(id==='mapTab') enqueueVisibleGeocodes(60);
  },120);
}

function label(t){
  if(t==='county') return 'County';
  if(t==='state') return 'State';
  if(t==='private') return 'Private';
  return 'City PD';
}

function readableLocation(s){
  return String(s||'')
    .replace(/\s+and\s+/gi,' & ')
    .replace(/\s+in\s+([^,]+)$/i,' — $1')
    .replace(/\s+/g,' ')
    .trim();
}

function sourceText(x){return x.source||SOURCE_TEXT}

function notesText(x){
  if(x.notes) return x.notes;
  const loc=(x.location||'').toUpperCase();
  const m=loc.match(/\b(?:U\.?S\.?|US|HIGHWAY|HWY\.?|STATE HIGHWAY|MN|MINNESOTA HIGHWAY|ROUTE)\s*[-.]?\s*(\d+[A-Z]?)/);
  if(m) return `Fixed LPR on ${m[0].replace(/\s+/g,' ')}.`;
  return 'Fixed LPR — official BCA location.';
}

function cleanAddressForGeocode(location){
  return String(location||'')
    .split('—')[0]
    .replace(/\(\d+\)/g,'')
    .replace(/,?\s*(northbound|southbound|eastbound|westbound)\b/gi,'')
    .replace(/\bHwy\.?\b/gi,'Highway')
    .replace(/\bUS Hwy\.?\b/gi,'US Highway')
    .replace(/\bU\.S\.\b/gi,'US')
    .replace(/\bAve\.\b/gi,'Avenue')
    .replace(/\bSt\.\b/gi,'Street')
    .replace(/\bRd\.\b/gi,'Road')
    .replace(/\bBlvd\.\b/gi,'Boulevard')
    .replace(/\s*&\s*/g,' and ')
    .replace(/\s+/g,' ')
    .trim();
}

function mapsQuery(x){
  return `${cleanAddressForGeocode(x.location)}, ${x.city}, Minnesota`;
}

function googleMapsUrl(x){
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery(x))}`;
}

function inMinnesota(lat,lng){
  return lat>=43.3 && lat<=49.6 && lng>=-97.4 && lng<=-89.3;
}

function coordInfo(x,{allowApprox=false}={}){
  if(MANUAL_COORD_OVERRIDES[x.id]){
    const [lat,lng]=MANUAL_COORD_OVERRIDES[x.id];
    return {lat,lng,quality:'verified',label:'Verified coordinate'};
  }

  if(geoCache[x.id]){
    return {
      lat:geoCache[x.id].lat,
      lng:geoCache[x.id].lng,
      quality:'geocoded',
      label:'Map lookup coordinate'
    };
  }

  if(allowApprox && typeof x.lat==='number' && typeof x.lng==='number'){
    return {lat:x.lat,lng:x.lng,quality:'approx',label:'Approximate fallback coordinate'};
  }

  return null;
}

function dot(color,quality='geocoded'){
  const core=quality==='approx'?8:11;
  const halo=quality==='approx'?24:38;
  const opacity=quality==='approx'?.38:1;
  const pulse=quality==='approx'?'':' pulse';
  const bg=quality==='approx'?'#0b1628':color;
  const border=quality==='approx'?`2px dashed ${color}`:'1px solid rgba(255,255,255,.55)';

  return L.divIcon({
    html:`
      <div class="glowMarker${pulse} ${quality}" style="--pin:${color};--core:${core}px;--halo:${halo}px;--op:${opacity};--bg:${bg};--border:${border}">
        <span class="glowHalo"></span>
        <span class="glowCore"></span>
      </div>
    `,
    className:'lprMarkerIcon',
    iconSize:[halo,halo],
    iconAnchor:[halo/2,halo/2]
  });
}

function initMap(){
  map=L.map('map',{
    zoomControl:false,
    attributionControl:true,
    preferCanvas:true
  }).setView([46.25,-94.2],6);

  const base=L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',{
    maxZoom:19,
    subdomains:'abcd',
    attribution:'© OpenStreetMap © CARTO',
    className:'baseTiles'
  }).addTo(map);

  const labels=L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',{
    maxZoom:19,
    subdomains:'abcd',
    attribution:'',
    className:'labelTiles',
    pane:'tilePane'
  }).addTo(map);

  map.fitBounds([[43.35,-97.35],[49.38,-89.45]],{padding:[6,6]});

  const controls=document.createElement('div');
  controls.id='mapControlDock';
  controls.innerHTML=`
    <button id="recenterMap" type="button" title="Recenter Minnesota">⌖</button>
    <button id="pinMode" type="button" title="Toggle approximate pins">Exact pins</button>
  `;
  document.getElementById('mapTab').appendChild(controls);

  document.getElementById('recenterMap').onclick=()=>map.fitBounds([[43.35,-97.35],[49.38,-89.45]],{padding:[6,6]});
  document.getElementById('pinMode').onclick=()=>{
    markerMode=markerMode==='verified'?'approx':'verified';
    document.getElementById('pinMode').textContent=markerMode==='verified'?'Exact pins':'All pins';
    renderMarkers();
  };

  const status=document.createElement('div');
  status.id='mapStatus';
  status.innerHTML='<b>Map:</b> default shows only verified/map-lookup pins, so bad fallback pins are hidden. Use “All pins” only to view approximate fallback points.';
  document.getElementById('mapTab').appendChild(status);

  map.on('moveend zoomend',()=>enqueueVisibleGeocodes(45));
}

function currentData(){
  const q=(search?.value||'').toLowerCase().trim();
  return LPR_LOCATIONS.filter(x=>{
    const matchType=!active||x.type===active;
    const matchSearch=!q||(x.location+' '+x.agency+' '+x.city).toLowerCase().includes(q);
    return matchType&&matchSearch;
  });
}

function renderMarkers(){
  markers.forEach(m=>m.remove());
  markers=[];
  markerById={};

  LPR_LOCATIONS.filter(x=>!active||x.type===active).forEach(x=>{
    const info=coordInfo(x,{allowApprox:markerMode==='approx'});
    if(!info) return;

    const color=colors[x.type]||colors.city;
    const marker=L.marker([info.lat,info.lng],{icon:dot(color,info.quality)})
      .addTo(map)
      .on('click',()=>focusLocation(x));

    marker.bindPopup(`<b>${readableLocation(x.location)}</b><br>${x.agency}<br><small>${x.city}, MN · ${info.quality==='approx'?'Approximate pin':'Map pin'}</small>`);
    markers.push(marker);
    markerById[x.id]=marker;
  });

  updatePinStats();
  setTimeout(()=>enqueueVisibleGeocodes(45),250);
}

function updatePinStats(){
  const exactCount=LPR_LOCATIONS.filter(x=>MANUAL_COORD_OVERRIDES[x.id]||geoCache[x.id]).length;
  const el=document.getElementById('mapStatus');
  if(el){
    el.innerHTML=`<b>Map:</b> ${exactCount} exact/map-lookup pins available. Wrong fallback pins are hidden by default. Tap a list item to map that location.`;
  }
}

function syncFilterButtons(){
  document.querySelectorAll('.filterChip').forEach(b=>{
    b.classList.toggle('active',active===b.dataset.filter);
  });
}

document.querySelectorAll('.filterChip').forEach(b=>{
  b.onclick=()=>{
    active=active===b.dataset.filter?null:b.dataset.filter;
    syncFilterButtons();
    renderMarkers();
    renderList();
  };
});

function renderList(){
  const data=currentData();
  list.innerHTML='';
  listCount.textContent=data.length;
  if(typeof resultCount!=='undefined'){
    resultCount.textContent=`${data.length} location${data.length===1?'':'s'}`;
  }

  const groups={};
  data.forEach(x=>{
    const city=x.city||'Unknown';
    (groups[city]??=[]).push(x);
  });

  Object.keys(groups).sort((a,b)=>a.localeCompare(b)).forEach(city=>{
    const h=document.createElement('div');
    h.className='cityHead';
    h.innerHTML=`<span>${city}</span><em>${groups[city].length}</em>`;
    list.appendChild(h);

    groups[city].forEach(x=>{
      const info=coordInfo(x,{allowApprox:false});
      const d=document.createElement('div');
      d.className=`item ${x.type||'city'}`;
      d.innerHTML=`
        <h3>${readableLocation(x.location)}</h3>
        <b>${x.agency}</b>
        <div class="itemMeta">
          <span class="badge ${x.type||'city'}">${label(x.type)}</span>
          <span class="fixedMini">⌖ Fixed</span>
          <span class="coordMini ${info?.quality||'lookup'}">${info?'Map pin':'Tap to map'}</span>
        </div>
        <span class="chev">›</span>
      `;
      d.onclick=()=>focusLocation(x);
      list.appendChild(d);
    });
  });
}

async function focusLocation(x){
  openSheet(x,'Looking up exact map position…');

  const cached=coordInfo(x,{allowApprox:false});
  if(cached){
    ensureMarker(x,cached);
    map?.flyTo([cached.lat,cached.lng],16,{duration:.55});
    openSheet(x);
    return;
  }

  const result=await geocodeNow(x);
  if(result){
    updateMarkerPosition(x,result.lat,result.lng,'geocoded',true);
    map?.flyTo([result.lat,result.lng],16,{duration:.55});
    renderList();
    updatePinStats();
    openSheet(x);
    return;
  }

  const approx=coordInfo(x,{allowApprox:true});
  if(approx){
    openSheet(x,'Exact map lookup failed. Showing approximate fallback only.');
    updateMarkerPosition(x,approx.lat,approx.lng,'approx',true);
    map?.flyTo([approx.lat,approx.lng],14,{duration:.55});
  }
}

function openSheet(x,extraNote=''){
  sheetBackdrop?.classList.add('open');
  sheet.classList.add('open');

  const type=x.type||'city';
  const color=colors[type]||colors.city;
  const info=coordInfo(x,{allowApprox:false});
  const coordLabel=extraNote || (info
    ? 'Map lookup coordinate available.'
    : 'Exact marker not loaded yet. Tap “Open location search in Maps” or wait for lookup.');

  sheetBody.innerHTML=`
    <span class="badge ${type}">• ${label(type)}</span>
    <h2>${readableLocation(x.location)}</h2>
    <p>
      <b style="color:${color}">${x.agency}</b><br>
      ${x.city}, Minnesota
    </p>
    <div class="kind">${x.kind||'Fixed'}</div>
    <hr>
    <p class="infoLine"><span>ⓘ</span><b>${notesText(x)}</b></p>
    <p class="coordLine"><span>⌖</span><span>${coordLabel}</span></p>
    <p class="sourceLine"><span>▤</span><span>Source: ${sourceText(x)}</span></p>
    <div class="sheetActions">
      <a class="mapLink" href="${googleMapsUrl(x)}" target="_blank" rel="noopener">Open location search in Maps</a>
    </div>
  `;
}

function closeSheet(){
  sheet.classList.remove('open');
  sheetBackdrop?.classList.remove('open');
}

function enqueueVisibleGeocodes(limit=45){
  if(!map) return;

  const candidates=LPR_LOCATIONS
    .filter(x=>(!active||x.type===active))
    .filter(x=>!MANUAL_COORD_OVERRIDES[x.id]&&!geoCache[x.id])
    .slice(0,limit);

  candidates.forEach(x=>enqueueGeocode(x));
  processGeoQueue();
}

function enqueueGeocode(x){
  if(!x||!x.id||geoCache[x.id]||MANUAL_COORD_OVERRIDES[x.id]||geoQueued.has(x.id)) return;
  geoQueued.add(x.id);
  geoQueue.push(x);
}

async function processGeoQueue(){
  if(geoBusy) return;
  geoBusy=true;

  while(geoQueue.length){
    const x=geoQueue.shift();

    try{
      const result=await geocodeNow(x);
      if(result){
        updateMarkerPosition(x,result.lat,result.lng,'geocoded',false);
        updatePinStats();
      }
    }catch(e){}

    await sleep(GEO_DELAY_MS);
  }

  geoBusy=false;
}

async function geocodeNow(x){
  if(!x||!x.id) return null;

  if(MANUAL_COORD_OVERRIDES[x.id]){
    const [lat,lng]=MANUAL_COORD_OVERRIDES[x.id];
    return {lat,lng};
  }

  if(geoCache[x.id]) return geoCache[x.id];

  const query=mapsQuery(x);
  const url='https://nominatim.openstreetmap.org/search'
    + `?format=json&limit=1&countrycodes=us&bounded=1&viewbox=-97.4,49.6,-89.3,43.3`
    + `&q=${encodeURIComponent(query)}`;

  const res=await fetch(url,{headers:{'Accept':'application/json'}});
  if(!res.ok) return null;

  const data=await res.json();
  if(!data||!data.length) return null;

  const lat=parseFloat(data[0].lat);
  const lng=parseFloat(data[0].lon);
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||!inMinnesota(lat,lng)) return null;

  const result={lat,lng,query,updatedAt:new Date().toISOString()};
  geoCache[x.id]=result;
  saveGeoCache();
  return result;
}

function ensureMarker(x,info){
  if(markerById[x.id]) return;
  updateMarkerPosition(x,info.lat,info.lng,info.quality||'geocoded',true);
}

function updateMarkerPosition(x,lat,lng,quality='geocoded',forceAdd=false){
  let marker=markerById[x.id];
  const color=colors[x.type]||colors.city;

  if(!marker && forceAdd){
    marker=L.marker([lat,lng],{icon:dot(color,quality)})
      .addTo(map)
      .on('click',()=>focusLocation(x));
    markers.push(marker);
    markerById[x.id]=marker;
  }

  if(!marker) return;

  marker.setLatLng([lat,lng]);
  marker.setIcon(dot(color,quality));
  marker.bindPopup(`<b>${readableLocation(x.location)}</b><br>${x.agency}<br><small>${x.city}, MN · ${quality==='approx'?'Approximate pin':'Map pin'}</small>`);
}

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

search.oninput=()=>{
  renderList();
  enqueueVisibleGeocodes(30);
};

initMap();
renderMarkers();
renderList();
showTab('mapTab');
