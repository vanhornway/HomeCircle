// Private map: Leaflet runs inside a WebView with no external scripts. Only
// map tiles are fetched (from the tile server your HomeCircle server names).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
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
  /** A small emoji badge: battery saver, settings issue, battery died. */
  badge?: string;
}

export interface MapPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius: number;
}

interface Props {
  tileUrl: string;
  attribution: string;
  // Changes when the map shows another circle: its people are fitted again.
  fitKey?: string | null;
  members?: MapMember[];
  places?: MapPlace[];
  /** Change `key` to fly to the same spot again. */
  focus?: { lat: number; lng: number; zoom?: number; key: number } | null;
  pickMode?: boolean;
  picked?: { lat: number; lng: number; radius: number } | null;
  onPick?: (p: { lat: number; lng: number }) => void;
  onMemberPress?: (id: string) => void;
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
.m{position:relative}
.m .b{position:absolute;right:-7px;top:-7px;width:20px;height:20px;border-radius:50%;background:#fff;font-size:12px;line-height:20px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.pl{background:#fff;color:#1d2422;border-radius:8px;padding:2px 8px;font:600 12px -apple-system,Roboto,sans-serif;border:1px solid #e2ddd4;white-space:nowrap;box-shadow:none}
.pl:before{display:none}
${dark ? '.leaflet-tile-pane{filter:brightness(.75) contrast(1.1) saturate(.8)}' : ''}
</style></head><body><div id="map"></div>
<script>${safeScript(LEAFLET_JS)}</script>
<script>
(function(){
  var map = L.map('map', {zoomControl:false, worldCopyJump:true}).setView([30,0], 2);
  L.tileLayer(${JSON.stringify(tileUrl)}, {maxZoom:19, attribution:${JSON.stringify(attribution)}, referrerPolicy:'strict-origin'}).addTo(map);
  var people = {}, placeLayer = L.layerGroup().addTo(map), pickLayer = L.layerGroup().addTo(map);
  var fitted = false, pick = false;
  function post(m){ window.ReactNativeWebView.postMessage(JSON.stringify(m)); }
  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function color(c){ return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#8a8f98'; }
  window.hc = {
    members: function(list){
      var seen = {};
      list.forEach(function(m){
        seen[m.id] = 1;
        var icon = L.divIcon({className:'', iconSize:[40,40], iconAnchor:[20,20],
          html:'<div class="m'+(m.stale?' s':'')+'" style="background:'+color(m.color)+'">'+esc(m.label)+(m.badge?'<span class="b">'+esc(m.badge)+'</span>':'')+'</div>'});
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
      if (!fitted && list.length) { fitted = true; hc.fit(list); }
    },
    fit: function(list){
      var pts = list.map(function(m){ return [m.lat,m.lng]; });
      if (pts.length === 1) map.setView(pts[0], 15);
      else if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.3), {maxZoom:15});
    },
    places: function(list){
      placeLayer.clearLayers();
      list.forEach(function(p){
        L.circle([p.lat,p.lng], {radius:p.radius, color:'#2f7d6d', weight:2, fillOpacity:.08, dashArray:'4 6', interactive:false})
          .bindTooltip(esc(p.name), {permanent:true, direction:'center', className:'pl'}).addTo(placeLayer);
      });
    },
    focus: function(lat,lng,zoom){ map.flyTo([lat,lng], zoom || Math.max(map.getZoom(), 15), {duration:.6}); },
    view: function(lat,lng,zoom){ fitted = true; map.setView([lat,lng], zoom, {animate:false}); },
    refit: function(list){ fitted = list.length > 0; if (list.length) hc.fit(list); },
    pickMode: function(on){ pick = on; },
    picked: function(p){
      pickLayer.clearLayers();
      if (p) L.circle([p.lat,p.lng], {radius:p.radius, color:'#2f7d6d', weight:2, fillOpacity:.15}).addTo(pickLayer);
    }
  };
  map.on('click', function(e){ if (pick) post({type:'pick', lat:e.latlng.lat, lng:e.latlng.lng}); });
  map.on('moveend', function(){ var c = map.getCenter(); post({type:'view', lat:c.lat, lng:c.lng, zoom:map.getZoom()}); });
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
  focus,
  pickMode = false,
  picked = null,
  onPick,
  onMemberPress,
  dark = false,
}: Props) {
  const ref = useRef<RNWebView>(null);
  const [ready, setReady] = useState(false);
  // Where the map was (lat, lng, zoom), and a new page if the old one's process died.
  const view = useRef<{ lat: number; lng: number; zoom: number } | null>(null);
  const [reloads, setReloads] = useState(0);
  const html = useMemo(() => buildHtml(tileUrl, attribution, dark), [tileUrl, attribution, dark]);
  const run = useCallback((js: string) => ready && ref.current?.injectJavaScript(`try{${js}}catch(e){};true;`), [ready]);

  useEffect(() => void run(`hc.members(${JSON.stringify(members)})`), [run, members]);
  useEffect(() => void run(`hc.places(${JSON.stringify(places)})`), [run, places]);
  useEffect(() => void run(`hc.pickMode(${pickMode})`), [run, pickMode]);
  useEffect(() => void run(`hc.picked(${JSON.stringify(picked)})`), [run, picked]);
  // Another circle: fit its people (the view kept for page reloads is per circle).
  const fitted = useRef(fitKey);
  useEffect(() => {
    if (!ready || fitted.current === fitKey) return;
    fitted.current = fitKey;
    run(`hc.refit(${JSON.stringify(members)})`);
    // Only when the circle changes, not on every location.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, run, fitKey]);
  const focusKey = focus?.key;
  const focusJs = focus ? `hc.focus(${focus.lat},${focus.lng},${focus.zoom ?? 0})` : null;
  useEffect(() => {
    if (focusJs) run(focusJs);
    // Only re-fly when the caller bumps `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, focusKey]);

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
    } else if (msg.type === 'view' && Number.isFinite(msg.lat) && Number.isFinite(msg.lng) && Number.isFinite(msg.zoom)) view.current = { lat: msg.lat, lng: msg.lng, zoom: msg.zoom };
    else if (msg.type === 'pick' && onPick) onPick({ lat: msg.lat, lng: msg.lng });
    else if (msg.type === 'member' && onMemberPress) onMemberPress(String(msg.id));
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
