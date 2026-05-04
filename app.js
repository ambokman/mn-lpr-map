const colors={city:'#39d5ff',county:'#9b4dff',state:'#ffcf32',private:'#ff9b2f'};
const SOURCE_TEXT='MN BCA official LPR registry — dps.mn.gov/divisions/bca/data-and-reports/agencies-use-lprs-lpr';
const GEO_CACHE_KEY='mn-lpr-geocode-cache-v3';
const GEO_DELAY_MS=1300;

/*
  The dataset contains public location descriptions plus fallback coordinates.
  Some fallback pins can be wrong. Add verified corrections here after checking Apple Maps / Google Maps.

  Format:
  'record-id': [latitude, longitude]

  Example:
  'fari-002': [44.000000, -93.000000]
*/
const MANUAL_COORD_OVERRIDES={
  // 'fari-002': [PASTE_VERIFIED_LATITUDE_HERE, PASTE_VERIFIED_LONGITUDE_HERE]
};

let active=null;
let markers=[];
let markerById={};
let map;
let geoQueue=[];
let geoQueued=new Set();
let geoBusy=false;
let geoCache=loadGeoCache();

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
    if(id==='mapTab') enqueueVisibleGeocodes(90);
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

function mapsQuery(x){
  return `${cleanAddressForGeocode(x.location)}, ${x.city}, Minnesota`;
}

function googleMapsUrl(x){
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery(x))}`;
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

function inMinnesota(lat,lng){
  return lat>=43.3 && lat<=49.6 && lng>=-97.4 && lng<=-89.3;
}

function coordInfo(x){
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

  if(typeof x.lat==='number' && typeof x.lng==='number'){
    return {lat:x.lat,lng:x.lng,quality:'approx',label:'Approximate coordinate'};
  }

  return null;
}

function dot(color,quality='approx'){
  const isApprox=quality==='approx';
  const core=isApprox?10:12;
  const halo=isApprox?30:42;
  const opacity=isApprox?.72:1;
  const pulse=isApprox?'':' pulse';

  return L.divIcon({
    html:`
      <div class="glowMarker${pulse}" style="--pin:${color};--core:${core}px;--halo:${halo}px;--op:${opacity}">
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

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',{
    maxZoom:19,
    attribution:'© OpenStreetMap © CARTO',
    subdomains:'abcd'
  }).addTo(map);

  map.fitBounds([[43.35,-97.35],[49.38,-89.45]],{padding:[6,6]});

  const status=document.createElement('div');
  status.id='mapStatus';
  status.innerHTML='<b>Map:</b> glowing pins show known LPR records. Hollow/soft pins may be approximate until verified.';
  document.getElementById('mapTab').appendChild(status);

  const locateButton=document.createElement('button');
  locateButton.id='recenterMap';
  locateButton.type='button';
  locateButton.innerHTML='⌖';
  locateButton.title='Recenter Minnesota';
  locateButton.onclick=()=>map.fitBounds([[43.35,-97.35],[49.38,-89.45]],{padding:[6,6]});
  document.getElementById('mapTab').appendChild(locateButton);

  map.on('moveend zoomend',()=>enqueueVisibleGeocodes(75));
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
    const info=coordInfo(x);
    if(!info) return;

    const color=colors[x.type]||colors.city;
    const marker=L.marker([info.lat,info.lng],{icon:dot(color,info.quality)})
      .addTo(map)
      .on('click',()=>focusLocation(x));

    marker.bindPopup(`<b>${readableLocation(x.location)}</b><br>${x.agency}<br><small>${x.city}, MN</small>`);
    markers.push(marker);
    markerById[x.id]=marker;
  });

  setTimeout(()=>enqueueVisibleGeocodes(90),350);
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
      const info=coordInfo(x);
      const d=document.createElement('div');
      d.className=`item ${x.type||'city'}`;
      d.innerHTML=`
        <h3>${readableLocation(x.location)}</h3>
        <b>${x.agency}</b>
        <div class="itemMeta">
          <span class="badge ${x.type||'city'}">${label(x.type)}</span>
          <span class="fixedMini">⌖ Fixed</span>
          <span class="coordMini ${info?.quality||'approx'}">${info?.quality==='approx'?'Approx. pin':'Map pin'}</span>
        </div>
        <span class="chev">›</span>
      `;
      d.onclick=()=>focusLocation(x);
      list.appendChild(d);
    });
  });
}

async function focusLocation(x){
  openSheet(x);

  const cached=coordInfo(x);
  if(cached && cached.quality!=='approx'){
    map?.flyTo([cached.lat,cached.lng],16,{duration:.55});
    return;
  }

  const result=await geocodeNow(x);
  if(result){
    updateMarkerPosition(x,result.lat,result.lng,'geocoded');
    map?.flyTo([result.lat,result.lng],16,{duration:.55});
    openSheet(x);
  }else if(cached){
    map?.flyTo([cached.lat,cached.lng],15,{duration:.55});
  }
}

function openSheet(x){
  sheetBackdrop?.classList.add('open');
  sheet.classList.add('open');

  const type=x.type||'city';
  const color=colors[type]||colors.city;
  const info=coordInfo(x);
  const coordLabel=info?.quality==='approx'
    ? 'Approximate marker — verify before relying on this exact pin.'
    : info?.label || 'Coordinate available';

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

function enqueueVisibleGeocodes(limit=75){
  if(!map) return;

  const bounds=map.getBounds();
  const candidates=LPR_LOCATIONS
    .filter(x=>(!active||x.type===active))
    .filter(x=>!MANUAL_COORD_OVERRIDES[x.id]&&!geoCache[x.id])
    .filter(x=>{
      if(typeof x.lat!=='number'||typeof x.lng!=='number') return true;
      return bounds.contains([x.lat,x.lng]);
    })
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
      if(result) updateMarkerPosition(x,result.lat,result.lng,'geocoded');
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

function updateMarkerPosition(x,lat,lng,quality='geocoded'){
  const marker=markerById[x.id];
  if(!marker) return;

  marker.setLatLng([lat,lng]);
  marker.setIcon(dot(colors[x.type]||colors.city,quality));
  marker.bindPopup(`<b>${readableLocation(x.location)}</b><br>${x.agency}<br><small>${x.city}, MN</small>`);
}

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

search.oninput=()=>{
  renderList();
  enqueueVisibleGeocodes(50);
};

initMap();
renderMarkers();
renderList();
showTab('mapTab');
