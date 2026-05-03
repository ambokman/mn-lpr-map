const colors={city:'#4da0ff',county:'#a94cff',state:'#24c7db',private:'#ff7c24'};
const SOURCE_TEXT='MN BCA official LPR registry — dps.mn.gov/divisions/bca/data-and-reports/agencies-use-lprs-lpr';
let active=null;
let markers=[];
let map;

const total=LPR_LOCATIONS.length;
count.textContent=total;
listCount.textContent=total;
listTotal.textContent=total;

function showTab(id){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  document.querySelectorAll('nav button').forEach(b=>b.classList.remove('on'));
  if(id==='mapTab') mapNav.classList.add('on');
  if(id==='listTab') listNav.classList.add('on');
  if(id==='aboutTab') aboutNav.classList.add('on');
  setTimeout(()=>map&&map.invalidateSize(),120);
}

function label(t){
  if(t==='county') return 'County';
  if(t==='state') return 'State';
  if(t==='private') return 'Private';
  return 'City PD';
}

function readableLocation(s){
  return String(s || '')
    .replace(/\s+and\s+/gi,' & ')
    .replace(/\s+in\s+([^,]+)$/i,' — $1')
    .replace(/\s+/g,' ')
    .trim();
}

function sourceText(x){
  return x.source || SOURCE_TEXT;
}

function notesText(x){
  if(x.notes) return x.notes;
  const loc=(x.location||'').toUpperCase();
  const m=loc.match(/\b(?:U\.?S\.?|US|HIGHWAY|HWY\.?|STATE HIGHWAY|MN|MINNESOTA HIGHWAY|ROUTE)\s*[-.]?\s*(\d+[A-Z]?)/);
  if(m) return `Fixed LPR on ${m[0].replace(/\s+/g,' ')}.`;
  return 'Fixed LPR — official BCA location.';
}

function dot(color){
  return L.divIcon({
    html:`<div class="markerDot" style="background:${color};box-shadow:0 0 0 5px ${color}35"></div>`,
    className:'',
    iconSize:[15,15],
    iconAnchor:[8,8]
  });
}

function initMap(){
  map=L.map('map',{zoomControl:false,attributionControl:true}).setView([46.25,-94.2],6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:18,
    attribution:'Leaflet'
  }).addTo(map);

  const bounds=[[43.35,-97.35],[49.38,-89.45]];
  map.fitBounds(bounds,{padding:[6,6]});
}

function currentData(){
  const q=(search?.value||'').toLowerCase().trim();
  return LPR_LOCATIONS.filter(x=>{
    const matchType=!active || x.type===active;
    const matchSearch=!q || (x.location+' '+x.agency+' '+x.city).toLowerCase().includes(q);
    return matchType && matchSearch;
  });
}

function renderMarkers(){
  markers.forEach(m=>m.remove());
  markers=[];

  const shown=LPR_LOCATIONS.filter(x=>!active || x.type===active);
  shown.forEach(x=>{
    if(typeof x.lat!=='number' || typeof x.lng!=='number') return;

    const color=colors[x.type]||colors.city;
    const marker=L.marker([x.lat,x.lng],{icon:dot(color)})
      .addTo(map)
      .on('click',()=>openSheet(x));

    marker.bindPopup(`<b>${readableLocation(x.location)}</b><br>${x.agency}<br><small>${x.city}, MN</small>`);
    markers.push(marker);
  });
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
  resultCount.textContent=`${data.length} location${data.length===1?'':'s'}`;

  const groups={};
  data.forEach(x=>{
    const city=x.city || 'Unknown';
    (groups[city]??=[]).push(x);
  });

  Object.keys(groups).sort((a,b)=>a.localeCompare(b)).forEach(city=>{
    const h=document.createElement('div');
    h.className='cityHead';
    h.innerHTML=`<span>${city}</span><em>${groups[city].length}</em>`;
    list.appendChild(h);

    groups[city].forEach(x=>{
      const d=document.createElement('div');
      d.className=`item ${x.type||'city'}`;
      d.innerHTML=`
        <h3>${readableLocation(x.location)}</h3>
        <b>${x.agency}</b>
        <div class="itemMeta">
          <span class="badge ${x.type||'city'}">${label(x.type)}</span>
          <span class="fixedMini">⌖ Fixed</span>
        </div>
        <span class="chev">›</span>
      `;
      d.onclick=()=>openSheet(x);
      list.appendChild(d);
    });
  });
}

function openSheet(x){
  sheetBackdrop.classList.add('open');
  sheet.classList.add('open');

  const type=x.type||'city';
  const color=colors[type]||colors.city;
  sheetBody.innerHTML=`
    <span class="badge ${type}">• ${label(type)}</span>
    <h2>${readableLocation(x.location)}</h2>
    <p>
      <b style="color:${color}">${x.agency}</b><br>
      ${x.city}, Minnesota
    </p>
    <div class="kind">${x.kind || 'Fixed'}</div>
    <hr>
    <p class="infoLine"><span>ⓘ</span><b>${notesText(x)}</b></p>
    <p class="sourceLine"><span>▤</span><span>Source: ${sourceText(x)}</span></p>
  `;
}

function closeSheet(){
  sheet.classList.remove('open');
  sheetBackdrop.classList.remove('open');
}

search.oninput=renderList;

initMap();
renderMarkers();
renderList();
showTab('mapTab');
