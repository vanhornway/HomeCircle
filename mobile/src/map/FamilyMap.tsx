// Private map: Leaflet runs inside a WebView with no external scripts. Only
// map tiles are fetched (from the tile server your HomeCircle server names).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { WebView as RNWebView, type WebViewMessageEvent } from 'react-native-webview';
import Constants from 'expo-constants';
import { LEAFLET_CSS, LEAFLET_JS } from './leafletAssets.generated';

// OpenStreetMap blocks tile requests that don't identify the app. The map page
// gets HomeCircle's site as its origin, so tiles send that as the Referer (not
// your server's address), and the WebView's user agent names the app.
const MAP_BASE_URL = 'https://homecircle.umair.us/';
const APP_NAME_FOR_USER_AGENT = `HomeCircle/${Constants.expoConfig?.version ?? 'app'}`;

// react-native-webview's class typings don't line up with React 19's JSX types yet.
const WebView = RNWebView as unknown as React.ComponentType<any>;

export interface MapMember {
  id: string;
  label: string;
  title: string;
  color: string;
  lat: number;
  lng: number;
  accuracy: number;
  stale: boolean;
  /** Shared as a rough area: draw the area's outline. */
  approximate?: boolean;
  /** A small emoji badge: battery saver, settings issue, battery died; 📡 shown at their tracker. */
  badge?: string;
  /** 'tracker': a Meshtastic tracker's pin (a rounded square with 🚗 or 🎒). */
  shape?: 'tracker';
}

export interface MapPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius: number;
}

/** Room taken by things drawn over the map (a top bar, a drawer), in pixels. */
export interface MapInset {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Where the map is: its size, and each person's spot on it in pixels. */
export interface MapView {
  w: number;
  h: number;
  zoom: number;
  pts: Record<string, [number, number]>;
}

export interface MapPath {
  id: string;
  points: [number, number][];
  /** Traced a while ago: drawn fainter. */
  old?: boolean;
}

interface Props {
  tileUrl: string;
  attribution: string;
  // Changes when the map shows another circle: its people are fitted again.
  fitKey?: string | null;
  members?: MapMember[];
  places?: MapPlace[];
  /** Radio paths to draw: tracker → relays → home base, as [lat, lng] points. */
  paths?: MapPath[];
  /** What to fit when the map opens (or shows another circle); everyone, if not given. */
  frame?: { lat: number; lng: number }[];
  /** Fits and fly-tos keep what they show clear of these. */
  inset?: MapInset;
  /** Change `key` to fly to the same spot again. */
  focus?: { lat: number; lng: number; zoom?: number; key: number } | null;
  /** Change `key` to fly to fit these points again. */
  fitTo?: { points: { lat: number; lng: number }[]; key: number } | null;
  pickMode?: boolean;
  picked?: { lat: number; lng: number; radius: number } | null;
  onPick?: (p: { lat: number; lng: number }) => void;
  onMemberPress?: (id: string) => void;
  /** Place names become tappable. */
  onPlacePress?: (id: string) => void;
  onView?: (v: MapView) => void;
  dark?: boolean;
}

const safeScript = (s: string) => s.replace(/<\/script/gi, '<\\/script');

function buildHtml(tileUrl: string, attribution: string, dark: boolean) {
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="referrer" content="no-referrer">
<style>${LEAFLET_CSS}
html,body,#map{height:100%;margin:0;background:${dark ? '#1a201e' : '#ece7df'}}
.m{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font:700 15px -apple-system,Roboto,sans-serif;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.3);box-sizing:border-box}
.m.s{filter:grayscale(.6);opacity:.85}
.m.t{border-radius:12px;font-size:20px}
.m{position:relative}
.m .b{position:absolute;right:-7px;top:-7px;width:20px;height:20px;border-radius:50%;background:#fff;font-size:12px;line-height:20px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.pl{position:absolute;left:0;top:0;transform:translate(-50%,24px);background:#fff;color:#1d2422;border-radius:8px;padding:3px 9px;font:600 12px -apple-system,Roboto,sans-serif;border:1px solid #e2ddd4;white-space:nowrap}
.pl.hide{visibility:hidden;pointer-events:none}
${dark ? '.leaflet-tile-pane{filter:brightness(.75) contrast(1.1) saturate(.8)}' : ''}
</style></head><body><div id="map"></div>
<script>${safeScript(LEAFLET_JS)}</script>
<script>
(function(){
  var map = L.map('map', {zoomControl:false, worldCopyJump:true}).setView([30,0], 2);
  var tiles = L.tileLayer(${JSON.stringify(tileUrl)}, {maxZoom:19, attribution:${JSON.stringify(attribution)}, referrerPolicy:'strict-origin'}).addTo(map);
  // A tile that fails (slow mobile data, a busy tile server) is asked for
  // again after 1, 4, 9, 16 and 25 s; otherwise it stays a blank square.
  function retry(img, n){
    if (n > 5 || !img.parentNode) return;
    img._tries = n;
    setTimeout(function(){
      if (!img.parentNode || img.complete && img.naturalWidth) return;
      var u = img.src.replace(/([?&])r=[0-9]+/, '').replace(/[?&]$/, '');
      img.src = u + (u.indexOf('?') < 0 ? '?' : '&') + 'r=' + n;
    }, 1000 * n * n);
  }
  tiles.on('tileerror', function(e){ retry(e.tile, (e.tile._tries || 0) + 1); });
  // Back online, or back in the app: every square that's still blank, again.
  function retryMissing(){
    Object.keys(tiles._tiles || {}).forEach(function(k){
      var t = tiles._tiles[k];
      if (t && t.el && !t.loaded) { t.el._tries = 0; retry(t.el, 1); }
    });
  }
  window.addEventListener('online', retryMissing);
  // Place names sit under people's pins, so a tap on someone at Home is theirs.
  map.createPane('placeNames').style.zIndex = 550;
  var people = {}, placeLayer = L.layerGroup().addTo(map), pickLayer = L.layerGroup().addTo(map), pathLayer = L.layerGroup().addTo(map);
  var pick = false, pad = {t:0, r:0, b:0, l:0};
  function post(m){ window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
  // Where the map is, and everyone on it in pixels (for chips at the edge).
  function where(){
    var c = map.getCenter(), s = map.getSize(), pts = {};
    Object.keys(people).forEach(function(id){
      var p = map.latLngToContainerPoint(people[id].marker.getLatLng());
      pts[id] = [Math.round(p.x), Math.round(p.y)];
    });
    post({type:'view', lat:c.lat, lng:c.lng, zoom:map.getZoom(), w:s.x, h:s.y, pts:pts});
  }
  // The middle of the part of the map that isn't covered: put lat,lng there at zoom z.
  function centerFor(lat, lng, z){
    return map.unproject(map.project([lat,lng], z).subtract([(pad.l - pad.r) / 2, (pad.t - pad.b) / 2]), z);
  }
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function color(c){ return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#8a8f98'; }
  // Place names sit just under their place. One that would land on someone's
  // pin or on another name is hidden until zooming in makes room (the first
  // places in the list win).
  function overlap(a, b){ return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; }
  function declutter(){
    var pins = Object.keys(people).map(function(id){ var el = people[id].marker.getElement(); return el && el.getBoundingClientRect(); }).filter(Boolean);
    var shown = [];
    placeLayer.eachLayer(function(l){
      var el = l.getElement && l.getElement(), lab = el && el.firstChild;
      if (!lab || !lab.classList || !lab.classList.contains('pl')) return;
      lab.classList.remove('hide');
      var r = lab.getBoundingClientRect();
      var hit = pins.some(function(p){ return overlap(r, p); }) || shown.some(function(q){ return overlap(r, q); });
      if (hit) lab.classList.add('hide'); else shown.push(r);
    });
  }
  map.on('zoomend moveend', declutter);
  window.hc = {
    members: function(list){
      var seen = {};
      list.forEach(function(m){
        seen[m.id] = 1;
        var icon = L.divIcon({className:'', iconSize:[40,40], iconAnchor:[20,20],
          html:'<div class="m'+(m.stale?' s':'')+(m.shape==='tracker'?' t':'')+'" style="background:'+color(m.color)+'">'+esc(m.label)+(m.badge?'<span class="b">'+esc(m.badge)+'</span>':'')+'</div>'});
        var p = people[m.id];
        if (!p) {
          p = people[m.id] = {
            marker: L.marker([m.lat,m.lng], {icon:icon}).addTo(map).on('click', function(){ post({type:'member', id:m.id}); }),
            acc: L.circle([m.lat,m.lng], {radius:m.accuracy||0, stroke:!!m.approximate, color:color(m.color), weight:2, dashArray:'6 6', fillColor:color(m.color), fillOpacity:m.approximate?.08:.12, interactive:false}).addTo(map)
          };
        } else {
          p.marker.setLatLng([m.lat,m.lng]).setIcon(icon);
          p.acc.setLatLng([m.lat,m.lng]).setRadius(m.accuracy||0).setStyle({stroke:!!m.approximate, fillOpacity:m.approximate?.08:.12});
        }
      });
      Object.keys(people).forEach(function(id){
        if (!seen[id]) { people[id].marker.remove(); people[id].acc.remove(); delete people[id]; }
      });
      where();
      declutter();
    },
    inset: function(p){ pad = p; },
    // Points [[lat,lng],…], clear of what's over the map (pins are 40 px, so 28 more all round).
    fit: function(pts, fly){
      if (!pts.length) return;
      map.invalidateSize(false);
      var s = map.getSize(), k = 1;
      // A short screen with the drawer open: shrink the room kept clear rather than fit into nothing.
      if (pad.t + pad.b + 56 > s.y - 80) k = Math.max(0, (s.y - 136) / (pad.t + pad.b));
      var o = {maxZoom:15, paddingTopLeft:[pad.l + 28, pad.t * k + 28], paddingBottomRight:[pad.r + 28, pad.b * k + 28]};
      var b = L.latLngBounds(pts).pad(0.1);
      if (fly && map.getZoom() >= 5) map.flyToBounds(b, L.extend(o, {duration:.8}));
      else map.fitBounds(b, L.extend(o, {animate:false}));
    },
    // Radio paths: a faint dashed line from each tracker, through the relays
    // with a known position, to the home base. Older paths are fainter.
    paths: function(list){
      pathLayer.clearLayers();
      list.forEach(function(p){
        if (!p.points || p.points.length < 2) return;
        L.polyline(p.points, {color:'#5b6b73', weight:3, opacity:p.old ? .25 : .55, dashArray:'2 7', lineCap:'round', interactive:false}).addTo(pathLayer);
        p.points.slice(1, -1).forEach(function(pt){
          L.circleMarker(pt, {radius:3, color:'#5b6b73', weight:1, opacity:p.old ? .3 : .6, fillOpacity:p.old ? .15 : .35, interactive:false}).addTo(pathLayer);
        });
      });
    },
    places: function(list, tap){
      placeLayer.clearLayers();
      list.forEach(function(p){
        L.circle([p.lat,p.lng], {radius:p.radius, color:'#2f7d6d', weight:2, fillOpacity:.08, dashArray:'4 6', interactive:false}).addTo(placeLayer);
        L.marker([p.lat,p.lng], {pane:'placeNames', interactive:!!tap, keyboard:false, icon:L.divIcon({className:'', iconSize:[0,0], html:'<div class="pl">'+esc(p.name)+'</div>'})})
          .on('click', function(){ post({type:'place', id:p.id}); }).addTo(placeLayer);
      });
      declutter();
    },
    // Asked for right at 'ready' (e.g. editing a place), the page may not have
    // its size yet: measure again, and jump rather than fly from the world view.
    focus: function(lat,lng,zoom){
      map.invalidateSize(false);
      var z = zoom || Math.max(map.getZoom(), 15);
      var c = centerFor(lat, lng, z);
      if (map.getZoom() < 5) map.setView(c, z, {animate:false});
      else map.flyTo(c, z, {duration:.6});
    },
    view: function(lat,lng,zoom){ map.setView([lat,lng], zoom, {animate:false}); },
    retryTiles: function(){ map.invalidateSize(); retryMissing(); },
    pickMode: function(on){ pick = on; },
    picked: function(p){
      pickLayer.clearLayers();
      if (p) L.circle([p.lat,p.lng], {radius:p.radius, color:'#2f7d6d', weight:2, fillOpacity:.15}).addTo(pickLayer);
    }
  };
  map.on('click', function(e){ if (pick) post({type:'pick', lat:e.latlng.lat, lng:e.latlng.lng}); });
  map.on('moveend', where);
  post({type:'ready'});
})();
</script></body></html>`;
}

export function FamilyMap({
  tileUrl,
  fitKey,
  attribution,
  members = [],
  places = [],
  paths = [],
  frame,
  inset,
  focus,
  fitTo,
  pickMode = false,
  picked = null,
  onPick,
  onMemberPress,
  onPlacePress,
  onView,
  dark = false,
}: Props) {
  const ref = useRef<RNWebView>(null);
  const [ready, setReady] = useState(false);
  // Where the map was (lat, lng, zoom), and a new page if the old one's process died.
  const view = useRef<{ lat: number; lng: number; zoom: number } | null>(null);
  const [reloads, setReloads] = useState(0);
  const html = useMemo(() => buildHtml(tileUrl, attribution, dark), [tileUrl, attribution, dark]);
  const run = useCallback((js: string) => ready && ref.current?.injectJavaScript(`try{${js}}catch(e){};true;`), [ready]);

  const insetJs = `hc.inset(${JSON.stringify({ t: inset?.top ?? 0, r: inset?.right ?? 0, b: inset?.bottom ?? 0, l: inset?.left ?? 0 })})`;
  // First, so a fit or fly-to in the same render keeps clear of the new inset.
  useEffect(() => void run(insetJs), [run, insetJs]);
  useEffect(() => void run(`hc.members(${JSON.stringify(members)})`), [run, members]);
  const pathsJs = JSON.stringify(paths);
  useEffect(() => void run(`hc.paths(${pathsJs})`), [run, pathsJs]);
  const tappable = !!onPlacePress;
  useEffect(() => void run(`hc.places(${JSON.stringify(places)},${tappable})`), [run, places, tappable]);
  useEffect(() => void run(`hc.pickMode(${pickMode})`), [run, pickMode]);
  useEffect(() => void run(`hc.picked(${JSON.stringify(picked)})`), [run, picked]);
  // Fit once there's something to fit, and again for another circle (not on
  // every location, nor when the page reloads: that goes back where it was).
  const frameJs = JSON.stringify((frame ?? members).map((p) => [p.lat, p.lng]));
  const fitted = useRef<{ key: string | null | undefined } | null>(null);
  useEffect(() => {
    if (!ready || (fitted.current && fitted.current.key === fitKey) || frameJs === '[]') return;
    fitted.current = { key: fitKey };
    run(`hc.fit(${frameJs})`);
  }, [ready, run, fitKey, frameJs]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') run('hc.retryTiles()');
    });
    return () => sub.remove();
  }, [run]);
  const focusKey = focus?.key;
  const focusJs = focus ? `hc.focus(${focus.lat},${focus.lng},${focus.zoom ?? 0})` : null;
  useEffect(() => {
    if (focusJs) run(focusJs);
    // Only re-fly when the caller bumps `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, focusKey]);
  const fitToKey = fitTo?.key;
  const fitToJs = fitTo ? `hc.fit(${JSON.stringify(fitTo.points.map((p) => [p.lat, p.lng]))},true)` : null;
  useEffect(() => {
    if (fitToJs) run(fitToJs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, fitToKey]);

  const onMessage = (e: WebViewMessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      const v = view.current;
      if (v) ref.current?.injectJavaScript(`try{hc.view(${v.lat},${v.lng},${v.zoom})}catch(e){};true;`);
      setReady(true);
    } else if (msg.type === 'view' && Number.isFinite(msg.lat) && Number.isFinite(msg.lng) && Number.isFinite(msg.zoom)) {
      view.current = { lat: msg.lat, lng: msg.lng, zoom: msg.zoom };
      if (onView && msg.pts && typeof msg.pts === 'object') onView({ w: Number(msg.w) || 0, h: Number(msg.h) || 0, zoom: msg.zoom, pts: msg.pts });
    } else if (msg.type === 'pick' && onPick) onPick({ lat: msg.lat, lng: msg.lng });
    else if (msg.type === 'member' && onMemberPress) onMemberPress(String(msg.id));
    else if (msg.type === 'place' && onPlacePress) onPlacePress(String(msg.id));
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      <WebView
        ref={ref}
        key={`${html.length}${dark ? 'd' : 'l'}${reloads}`}
        originWhitelist={['*']}
        // The map page may only ever be itself: block link taps (e.g. attribution).
        onShouldStartLoadWithRequest={(r: { url: string }) => r.url === MAP_BASE_URL || r.url.startsWith('about:')}
        source={{ html, baseUrl: MAP_BASE_URL }}
        applicationNameForUserAgent={APP_NAME_FOR_USER_AGENT}
        onMessage={onMessage}
        onLoadStart={() => setReady(false)}
        // The page's process died (low memory): start a new one, where the map was.
        onRenderProcessGone={() => setReloads((n) => n + 1)}
        onContentProcessDidTerminate={() => setReloads((n) => n + 1)}
        javaScriptEnabled
        domStorageEnabled={false}
        geolocationEnabled={false}
        allowFileAccess={false}
        setSupportMultipleWindows={false}
        incognito
        style={{ flex: 1, backgroundColor: 'transparent' }}
      />
    </View>
  );
}
